/**
 * slack.js — Slack integration stubs for Phase B.
 *
 * Phase D will replace console.log with real @slack/web-api calls using
 * a WebClient initialized from the SLACK_BOT_TOKEN secret.
 * Pinned-status approach: one message per event in #int-gameday-ops,
 * edited in place via chat.update. Owner DMs via conversations.open + chat.postMessage.
 * Threaded escalations (flag/block notes) posted as replies under the pinned message.
 */

'use strict';

// Phase D: const { WebClient } = require('@slack/web-api');
// Phase D: let _client = null;
// Phase D: async function client() { if (_client) return _client; ... }

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '';

/**
 * Post the initial pinned status message for a new event.
 * Returns the message ts (timestamp) to store in games.pinned_slack_message_ts.
 */
async function postPinnedStatus(gameId, eventData) {
  console.log(`[slack] postPinnedStatus gameId=${gameId} name="${eventData.name}" (stub)`);
  return null; // Phase D returns real ts
}

/**
 * Update the existing pinned status message in place.
 */
async function updatePinnedStatus(gameId, eventData, pinnedTs) {
  console.log(`[slack] updatePinnedStatus gameId=${gameId} ts=${pinnedTs} status=${eventData.status} (stub)`);
}

/**
 * Send a DM to a specific Slack user (by slackUserId, e.g. "U01ABC23DEF").
 */
async function dmOwner(slackUserId, message) {
  console.log(`[slack] dmOwner userId=${slackUserId} message="${message}" (stub)`);
}

/**
 * Post a threaded escalation note under the event's pinned message.
 */
async function postEscalation(gameId, pinnedTs, stepName, type, note) {
  console.log(`[slack] postEscalation gameId=${gameId} step="${stepName}" type=${type} note="${note}" (stub)`);
}

/**
 * Post the final Stream Live summary, replacing the pinned status.
 */
async function postStreamLive(gameId, pinnedTs, summaryText) {
  console.log(`[slack] postStreamLive gameId=${gameId} (stub)`);
}

module.exports = { postPinnedStatus, updatePinnedStatus, dmOwner, postEscalation, postStreamLive };
