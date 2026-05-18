/*
 * state.js — single seam for all data reads/writes.
 *
 * Phase A (was):  backed by localStorage + in-memory mock data.
 * Phase B (was):  function bodies call fetch() against Node/Express backend.
 *                  UI does not change — all exported signatures are identical.
 * Phase C (now):  subscribe() opens an AppSync Event API WebSocket. Mutations
 *                  publish to the channel so all tabs on the same gameId sync live.
 *
 * Backend base URL: defaults to http://localhost:3005.
 * Set window.QUINTAR_API_BASE before importing to override (e.g. for prod).
 *
 * AppSync config: set window.APPSYNC_CONFIG = { endpoint, region, apiKey }
 * before importing (injected by a <script> tag in the HTML).
 */

import { getCurrentUser } from './identity.js';

const API_BASE = (typeof window !== 'undefined' && window.QUINTAR_API_BASE)
  ? window.QUINTAR_API_BASE.replace(/\/$/, '')
  : 'http://localhost:3005';

const APPSYNC = (typeof window !== 'undefined' && window.APPSYNC_CONFIG)
  ? window.APPSYNC_CONFIG
  : null;

// Unique ID for this browser tab — used to filter out self-published AppSync events.
const _tabId = Math.random().toString(36).slice(2, 10);

// In-memory cache of loaded reference data (still fetched from static JSON files)
let _roster   = null;
let _template = null;

// Subscriber callbacks per gameId
const _subs = new Map(); // gameId -> Set<callback>

/* ========================================================================
 * INTERNAL HELPERS
 * ====================================================================== */

async function _api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = res.statusText; }
    throw new Error(`API ${method} ${path} → ${res.status}: ${msg}`);
  }
  return res.json();
}

// Local-mutation broadcast: marks patch as local so subscribers can skip it
// (the UI already updated synchronously before this fires).
function _emit(gameId, patch) {
  const set = _subs.get(gameId);
  if (!set) return;
  for (const cb of set) {
    try { cb({ ...patch, _isLocal: true }); } catch (e) { console.error('subscriber error', e); }
  }
}

// Remote-event broadcast: called when AppSync delivers an event from another tab.
function _emitRemote(gameId, patch) {
  const set = _subs.get(gameId);
  if (!set) return;
  for (const cb of set) {
    try { cb(patch); } catch (e) { console.error('subscriber error', e); }
  }
}

/* ========================================================================
 * APPSYNC EVENT API — via Amplify library (loaded from CDN)
 *
 * The raw WebSocket protocol requires auth headers that browsers can't set.
 * Amplify handles this internally, so we load it dynamically from esm.sh
 * rather than bundling it (no bundler in this project).
 * ====================================================================== */

let _amplifyEvents = null; // cached after first load

async function _initAmplify() {
  if (_amplifyEvents) return _amplifyEvents;
  if (!APPSYNC) return null;
  try {
    const [{ Amplify }, { events }] = await Promise.all([
      import('https://esm.sh/aws-amplify@6'),
      import('https://esm.sh/aws-amplify@6/data'),
    ]);
    Amplify.configure({
      API: {
        Events: {
          endpoint: APPSYNC.endpoint,
          region:   APPSYNC.region,
          defaultAuthMode: 'apiKey',
          apiKey:   APPSYNC.apiKey,
        },
      },
    });
    _amplifyEvents = events;
    return events;
  } catch (e) {
    console.error('Amplify load failed:', e);
    return null;
  }
}

// Open an Amplify Events subscription on channel /default/updates.
// Calls onData(event) for every event from a different tab on the same gameId.
// Returns a Promise that resolves to a teardown function () => void.
async function _appSyncConnect(gameId, onData) {
  const ev = await _initAmplify();
  if (!ev) return () => {};
  const channel = await ev.connect('/default/updates');
  channel.subscribe({
    next: (raw) => {
      // Amplify wraps the payload under raw.event
      const payload = raw?.event ?? raw;
      if (payload.gameId === gameId && payload._tabId !== _tabId) onData(payload);
    },
    error: (err) => console.error('AppSync subscribe error:', err),
  });
  return () => channel.close();
}

// Publish a step-transition event via Amplify Events.
// Fire-and-forget — failures are logged but not re-thrown.
async function _appSyncPublish(payload) {
  const ev = await _initAmplify();
  if (!ev) return;
  try {
    await ev.post('/default/updates', payload);
  } catch (e) {
    console.warn('AppSync publish failed:', e);
  }
}

/* ========================================================================
 * REFERENCE DATA (roster + template)
 * Still fetched from static JSON files — no backend involvement.
 * ====================================================================== */

export async function loadRoster() {
  if (_roster) return _roster;
  // Prefer the server's enriched roster (adds live slackHandle from Slack users.info).
  // Fall back to the static roster.json if the API is unavailable.
  try {
    const res = await fetch(`${API_BASE}/api/roster`);
    if (res.ok) {
      _roster = await res.json();
      return _roster;
    }
  } catch (_) { /* fall through */ }
  const res = await fetch('roster.json');
  if (!res.ok) throw new Error(`roster.json fetch failed: ${res.status}`);
  _roster = await res.json();
  return _roster;
}

export async function loadTemplate() {
  if (_template) return _template;
  const res = await fetch('template.json');
  if (!res.ok) throw new Error(`template.json fetch failed: ${res.status}`);
  _template = await res.json();
  return _template;
}

/**
 * Resolve an owner name to a roster entry, or a synthetic entry for specials.
 */
export function resolveOwner(name) {
  if (!_roster) return null;
  const hit = _roster.find(p => p.name === name);
  if (hit) return hit;
  if (name === 'Operations Team') return { name, isGroup: true };
  if (name === 'TBD')             return { name, isPlaceholder: true };
  return { name, isUnknown: true };
}

/* ========================================================================
 * SESSION CRUD
 * ====================================================================== */

export async function listEvents({ status } = {}) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return _api('GET', `/api/games${qs}`);
}

export async function getEvent(gameId) {
  try {
    return await _api('GET', `/api/games/${encodeURIComponent(gameId)}`);
  } catch (e) {
    if (e.message.includes('404')) return null;
    throw e;
  }
}

export async function createEvent({ name, sport, venue, customerTeam, startsAt, ownerOverrides = {}, gameId }) {
  const event = await _api('POST', '/api/games', {
    name, sport, venue, customerTeam, startsAt, ownerOverrides,
    ...(gameId ? { gameId } : {}),
  });
  _emit(event.gameId, { type: 'event.created', event });
  return event;
}

export async function updateEvent(gameId, patch) {
  const event = await _api('PATCH', `/api/games/${encodeURIComponent(gameId)}`, patch);
  _emit(gameId, { type: 'event.updated', patch });
  return event;
}

export async function endEvent(gameId) {
  const event = await _api('POST', `/api/games/${encodeURIComponent(gameId)}/end`);
  _emit(gameId, { type: 'event.ended' });
  return event;
}

export async function archiveEvent(gameId) {
  const event = await _api('POST', `/api/games/${encodeURIComponent(gameId)}/archive`);
  _emit(gameId, { type: 'event.archived' });
  return event;
}

/* ========================================================================
 * STEP MUTATIONS
 * ====================================================================== */

export async function transitionStep(gameId, stepId, transition, payload = {}) {
  // Inject actor from the locally-stored identity so the server can attribute
  // activity log + Slack escalation messages. Caller's payload.actor wins.
  const actor = payload.actor ?? getCurrentUser()?.name;
  const step = await _api(
    'POST',
    `/api/games/${encodeURIComponent(gameId)}/steps/${encodeURIComponent(stepId)}/transition`,
    { transition, payload: { ...payload, actor } }
  );
  _emit(gameId, { type: 'step.transition', stepId, transition, step });
  // Publish to AppSync so other tabs receive the update in real time.
  _appSyncPublish({ gameId, stepId, transition, actor, _tabId });
  return step;
}

export async function assignStepOwners(gameId, stepId, owners) {
  const step = await _api(
    'PATCH',
    `/api/games/${encodeURIComponent(gameId)}/steps/${encodeURIComponent(stepId)}/owners`,
    { owners }
  );
  _emit(gameId, { type: 'step.owners', stepId, owners });
  return step;
}

export async function updateStepNote(gameId, stepId, text) {
  const actor = getCurrentUser()?.name || null;
  const step = await _api(
    'PATCH',
    `/api/games/${encodeURIComponent(gameId)}/steps/${encodeURIComponent(stepId)}/note`,
    { text, actor }
  );
  _emit(gameId, { type: 'step.note', stepId, step });
  // Publish to AppSync so other tabs receive the note update in real time.
  _appSyncPublish({ gameId, stepId, transition: 'note', userNote: step.userNote, userNoteActor: step.userNoteActor, userNoteUpdatedAt: step.userNoteUpdatedAt, actor, _tabId });
  return step;
}

/* ========================================================================
 * ATTENTION QUERY
 * ====================================================================== */

export async function getAttentionForUser(userName) {
  return _api('GET', `/api/attention/${encodeURIComponent(userName)}`);
}

/* ========================================================================
 * REAL-TIME SUBSCRIPTION — AppSync Event API
 * ====================================================================== */

export function subscribe(gameId, callback) {
  if (!_subs.has(gameId)) _subs.set(gameId, new Set());
  _subs.get(gameId).add(callback);

  // Open AppSync WebSocket; deliver remote events to all registered callbacks.
  // This is intentionally fire-and-forget — subscribe() stays synchronous
  // so callers don't need to await it.
  _appSyncConnect(gameId, (ev) => {
    const type = ev.transition === 'note' ? 'step.note' : 'step.transition';
    _emitRemote(gameId, { type, ...ev });
  }).catch(e => console.error('AppSync connect failed:', e));

  return () => {
    const set = _subs.get(gameId);
    if (set) set.delete(callback);
  };
}

/* ========================================================================
 * DEV HELPERS
 * ====================================================================== */

export async function _devReset() {
  // In Phase B there's no equivalent server-side wipe — use this only against
  // a local dev server where you can manually DELETE data/ops.db and restart.
  console.warn('_devReset(): delete data/ops.db on the server and restart to fully reset.');
}

export function _devSnapshot() {
  console.warn('_devSnapshot(): use GET /api/games to inspect server state.');
}
