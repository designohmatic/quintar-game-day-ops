/**
 * roster-service.js — In-memory enriched roster.
 *
 * roster.json holds { name, slackId } per person — handles are intentionally
 * not stored because Slack display names are fluid. On startup we call
 * Slack users.info for each slackId to fetch the live display_name, then
 * refresh hourly. The enriched roster is exposed via GET /api/roster.
 *
 * Lookup by canonical name (case-sensitive, matches roster.json) is used by
 * the games route to resolve owner names → slackUserId for DM routing.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const { getClient } = require('./slack');

const ROSTER_PATH = path.resolve(__dirname, '../roster.json');
const REFRESH_MS  = 60 * 60 * 1000; // 1 hour

let _baseRoster = null;       // raw parsed roster.json
let _enriched   = null;       // [{ name, slackId, slackHandle? }, ...]
let _byName     = new Map();  // name → enriched entry
let _refreshTimer = null;

function _readBase() {
  if (_baseRoster) return _baseRoster;
  _baseRoster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
  return _baseRoster;
}

async function _enrichOnce() {
  const base = _readBase();
  const client = await getClient();

  const out = [];
  for (const entry of base) {
    if (!entry.slackId || !client) {
      out.push({ ...entry });
      continue;
    }
    try {
      const res = await client.users.info({ user: entry.slackId });
      const profile = res.user?.profile || {};
      const handle  = profile.display_name_normalized
                   || profile.display_name
                   || profile.real_name_normalized
                   || profile.real_name
                   || null;
      out.push({ ...entry, slackHandle: handle ? `@${handle}` : null });
    } catch (err) {
      console.warn(`[roster] users.info ${entry.name} (${entry.slackId}) failed: ${err.data?.error || err.message}`);
      out.push({ ...entry });
    }
  }

  _enriched = out;
  _byName   = new Map(out.map(e => [e.name, e]));
  return out;
}

/**
 * Kick off the first enrichment and schedule hourly refreshes.
 * Returns the initial enriched roster (may be missing handles if Slack is unavailable).
 */
async function start() {
  if (_refreshTimer) return _enriched; // already running
  await _enrichOnce().catch(err => {
    console.error('[roster] initial enrichment failed:', err.message);
  });
  _refreshTimer = setInterval(() => {
    _enrichOnce().catch(err => {
      console.error('[roster] refresh failed:', err.message);
    });
  }, REFRESH_MS);
  if (_refreshTimer.unref) _refreshTimer.unref();
  return _enriched;
}

function getRoster() {
  return _enriched || _readBase();
}

/**
 * Look up a slackId by canonical name. Returns null for specials
 * (Operations Team, TBD) and unknown names.
 */
function slackIdForName(name) {
  const entry = _byName.get(name);
  return entry?.slackId || null;
}

module.exports = { start, getRoster, slackIdForName };
