/**
 * slack.js — Slack integration.
 *
 * Pinned-status approach: one chat.postMessage per event in SLACK_CHANNEL_ID;
 * subsequent state changes chat.update the same message in place. Owner DMs
 * via conversations.open + chat.postMessage. Flag/block notes posted as
 * threaded replies under the pinned message.
 *
 * All exported functions are safe to call without awaiting — they swallow
 * Slack API errors internally so a Slack hiccup never breaks the REST path.
 */

'use strict';

const { WebClient } = require('@slack/web-api');
const { getSecret } = require('./secrets');

const CHANNEL_ID    = process.env.SLACK_CHANNEL_ID || '';
const APP_BASE_URL  = (process.env.APP_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

let _client = null;
let _clientLoadPromise = null;

async function getClient() {
  if (_client) return _client;
  if (_clientLoadPromise) return _clientLoadPromise;
  _clientLoadPromise = (async () => {
    const token = await getSecret('SLACK_BOT_TOKEN');
    if (!token) {
      console.warn('[slack] SLACK_BOT_TOKEN missing — Slack calls will no-op');
      return null;
    }
    _client = new WebClient(token);
    return _client;
  })();
  return _clientLoadPromise;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function linkToEvent(gameId) {
  return `${APP_BASE_URL}/event-view.html?gameId=${encodeURIComponent(gameId)}`;
}

function ownerList(owners) {
  if (!Array.isArray(owners) || owners.length === 0) return 'unassigned';
  return owners.join(', ');
}

/**
 * Build the pinned-status message text.
 * Format: [Game name] — <Phase> • N/M steps • Current: <Step> (<Owners>)
 * Variants for flagged/blocked/complete.
 */
function formatPinnedStatus(event) {
  const steps     = event.steps || [];
  const total     = steps.length;
  const done      = steps.filter(s => s.status === 'complete').length;
  const active    = steps.filter(s => s.status === 'active');
  const flagged   = steps.filter(s => s.status === 'flagged');
  const blocked   = steps.filter(s => s.status === 'blocked');

  // Phase: prefer the phase of the first non-complete in-flight step;
  // fall back to last completed step's phase; finally first step's phase.
  const inFlight  = active[0] || flagged[0] || blocked[0];
  const lastDone  = [...steps].reverse().find(s => s.status === 'complete');
  const phaseName = inFlight?.phase || lastDone?.phase || steps[0]?.phase || '—';

  let currentLine;
  if (blocked.length > 0) {
    const s = blocked[0];
    currentLine = `🔴 BLOCKED: ${s.name} (${ownerList(s.owners)})`;
  } else if (flagged.length > 0) {
    const s = flagged[0];
    currentLine = `⚠️ ${s.name} flagged (${ownerList(s.owners)})`;
  } else if (active.length > 0) {
    const s = active[0];
    const extra = active.length > 1 ? ` +${active.length - 1} more` : '';
    currentLine = `Current: ${s.name} (${ownerList(s.owners)})${extra}`;
  } else if (done === total && total > 0) {
    currentLine = '✅ All steps complete — ready to go live';
  } else {
    currentLine = 'Setup — no active step yet';
  }

  return `*[${event.name}]* — ${phaseName} • ${done}/${total} steps • ${currentLine}\n${linkToEvent(event.gameId)}`;
}

function formatStepActivationDM(event, step) {
  return `*[${event.name}]* Your step is now active: *${step.name}*\n${linkToEvent(event.gameId)}`;
}

function formatStepIssueDM(event, step, type, note) {
  const icon = type === 'block' ? '🔴 BLOCKED' : '⚠️ FLAGGED';
  const noteLine = note ? `\n> ${note}` : '';
  return `${icon} *[${event.name}]* ${step.name}${noteLine}\n${linkToEvent(event.gameId)}`;
}

function formatStreamLive(event, totalElapsedMs) {
  const mins = Math.floor((totalElapsedMs || 0) / 60000);
  const h    = Math.floor(mins / 60);
  const m    = mins % 60;
  const elapsed = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `🟢 *[${event.name}]* is streaming live — set day completed in ${elapsed}\n${linkToEvent(event.gameId)}`;
}

// ── Slack API wrappers (all fire-and-forget safe) ───────────────────────────

/**
 * Post the initial pinned status message for a new event.
 * Returns the message ts (timestamp) to store in games.pinned_slack_message_ts,
 * or null if Slack is unavailable.
 */
async function postPinnedStatus(gameId, event) {
  try {
    const client = await getClient();
    if (!client || !CHANNEL_ID) return null;
    const res = await client.chat.postMessage({
      channel: CHANNEL_ID,
      text:    formatPinnedStatus(event),
      unfurl_links: false,
      unfurl_media: false,
    });
    return res.ts || null;
  } catch (err) {
    console.error('[slack] postPinnedStatus failed:', err.data?.error || err.message);
    return null;
  }
}

/**
 * Update the existing pinned status message in place.
 */
async function updatePinnedStatus(gameId, event, pinnedTs) {
  try {
    if (!pinnedTs) return;
    const client = await getClient();
    if (!client || !CHANNEL_ID) return;
    await client.chat.update({
      channel: CHANNEL_ID,
      ts:      pinnedTs,
      text:    formatPinnedStatus(event),
    });
  } catch (err) {
    console.error('[slack] updatePinnedStatus failed:', err.data?.error || err.message);
  }
}

/**
 * Send a DM to a specific Slack user (by slackUserId, e.g. "U01ABC23DEF").
 */
async function dmOwner(slackUserId, message) {
  try {
    if (!slackUserId) return;
    const client = await getClient();
    if (!client) return;
    const open = await client.conversations.open({ users: slackUserId });
    const channelId = open.channel?.id;
    if (!channelId) return;
    await client.chat.postMessage({
      channel: channelId,
      text:    message,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (err) {
    console.error(`[slack] dmOwner ${slackUserId} failed:`, err.data?.error || err.message);
  }
}

/**
 * Post a threaded escalation note under the event's pinned message.
 * type: 'flag' | 'block' | 'resolve'
 */
async function postEscalation(gameId, pinnedTs, stepName, type, note, actor) {
  try {
    if (!pinnedTs) return;
    const client = await getClient();
    if (!client || !CHANNEL_ID) return;

    let text;
    const noteStr = note ? `: "${note}"` : '';
    const by      = actor ? ` by ${actor}` : '';
    if (type === 'block') {
      text = `🔴 BLOCKED: *${stepName}*${by}${noteStr}`;
    } else if (type === 'flag') {
      text = `⚠️ *${stepName}* flagged${by}${noteStr}`;
    } else if (type === 'resolve') {
      text = `✅ *${stepName}* resolved${by}`;
    } else {
      text = `_${type}_ *${stepName}*${by}${noteStr}`;
    }

    await client.chat.postMessage({
      channel:  CHANNEL_ID,
      thread_ts: pinnedTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (err) {
    console.error('[slack] postEscalation failed:', err.data?.error || err.message);
  }
}

/**
 * Post the Stream Live summary. We update the pinned message in place so
 * the channel keeps a single canonical row per event, then also post a
 * fresh message so it surfaces in the channel timeline.
 */
async function postStreamLive(gameId, pinnedTs, event, totalElapsedMs) {
  try {
    const client = await getClient();
    if (!client || !CHANNEL_ID) return;
    const summary = formatStreamLive(event, totalElapsedMs);

    if (pinnedTs) {
      await client.chat.update({ channel: CHANNEL_ID, ts: pinnedTs, text: summary });
    }
    await client.chat.postMessage({
      channel: CHANNEL_ID,
      text:    summary,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (err) {
    console.error('[slack] postStreamLive failed:', err.data?.error || err.message);
  }
}

module.exports = {
  getClient,
  postPinnedStatus,
  updatePinnedStatus,
  dmOwner,
  postEscalation,
  postStreamLive,
  // formatters exposed for tests / direct use by routes
  formatPinnedStatus,
  formatStepActivationDM,
  formatStepIssueDM,
  formatStreamLive,
  linkToEvent,
};
