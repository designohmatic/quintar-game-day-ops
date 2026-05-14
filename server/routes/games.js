'use strict';

const express  = require('express');
const router   = express.Router();
const { getDb, rowToEvent, rowToStep } = require('../db');
const { materializeSteps } = require('../template-loader');
const slack          = require('../slack');
const rosterService  = require('../roster-service');

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generateGameId(name, startsAt, existing) {
  const dateStr = (startsAt || new Date().toISOString().split('T')[0]).slice(0, 10);
  const base    = `${slugify(name)}-${dateStr}`;
  let   id      = base;
  let   n       = 2;
  while (existing.has(id)) { id = `${base}-${n++}`; }
  return id;
}

function fetchEvent(db, gameId) {
  const gameRow  = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!gameRow) return null;
  const stepRows = db.prepare('SELECT * FROM step_states WHERE game_id = ? ORDER BY seq ASC').all(gameId);
  return rowToEvent(gameRow, stepRows);
}

/**
 * Fire-and-forget Slack notification after a step transition.
 * Never throws — Slack errors are swallowed inside slack.js. The REST
 * response has already been sent by the time this runs.
 */
function _notifyTransitionAsync(gameId, stepId, transition, payload) {
  setImmediate(async () => {
    try {
      const db    = getDb();
      const event = fetchEvent(db, gameId);
      if (!event) return;
      const step  = event.steps.find(s => s.stepId === stepId);
      if (!step) return;

      // Always reflect new state in the pinned message
      slack.updatePinnedStatus(gameId, event, event.pinnedSlackMessageTs);

      const owners = step.owners || [];
      const slackIds = owners
        .map(name => rosterService.slackIdForName(name))
        .filter(Boolean);

      if (transition === 'activate') {
        const msg = slack.formatStepActivationDM(event, step);
        for (const uid of slackIds) slack.dmOwner(uid, msg);
      } else if (transition === 'flag' || transition === 'block') {
        slack.postEscalation(gameId, event.pinnedSlackMessageTs, step.name, transition, payload?.note, payload?.actor);
        const msg = slack.formatStepIssueDM(event, step, transition, payload?.note);
        for (const uid of slackIds) slack.dmOwner(uid, msg);
      } else if (transition === 'resolve') {
        slack.postEscalation(gameId, event.pinnedSlackMessageTs, step.name, 'resolve', null, payload?.actor);
      }
      // complete / deactivate / undo: pinned-status update only (already fired above)
    } catch (err) {
      console.error('[slack] notifyTransition failed:', err.message);
    }
  });
}

// ── GET /api/games ────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  const { status } = req.query;

  let query = 'SELECT * FROM games ORDER BY created_at DESC';
  const params = [];

  if (status === 'active') {
    query  = "SELECT * FROM games WHERE status IN ('setup','live') ORDER BY created_at DESC";
  } else if (status === 'recent') {
    query  = "SELECT * FROM games WHERE status IN ('complete','archived') ORDER BY created_at DESC";
  }

  const gameRows = db.prepare(query).all(...params);
  const events   = gameRows.map(g => {
    const stepRows = db.prepare('SELECT * FROM step_states WHERE game_id = ? ORDER BY seq ASC').all(g.id);
    return rowToEvent(g, stepRows);
  });
  res.json(events);
});

// ── GET /api/games/:gameId ────────────────────────────────────────────────────

router.get('/:gameId', (req, res) => {
  const event = fetchEvent(getDb(), req.params.gameId);
  if (!event) return res.status(404).json({ error: 'event not found' });
  res.json(event);
});

// ── POST /api/games ───────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const db = getDb();
  const { name, sport, venue, customerTeam, startsAt, ownerOverrides = {}, gameId: explicitGameId } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  let gameId;
  if (explicitGameId) {
    const exists = db.prepare('SELECT 1 FROM games WHERE id = ?').get(explicitGameId);
    if (exists) return res.status(409).json({ error: `gameId already exists: ${explicitGameId}` });
    gameId = explicitGameId;
  } else {
    const existingIds = new Set(db.prepare('SELECT id FROM games').all().map(r => r.id));
    gameId = generateGameId(name, startsAt, existingIds);
  }

  const now   = Date.now();
  const steps = materializeSteps(ownerOverrides);

  const insertGame = db.prepare(`
    INSERT INTO games (id, name, sport, venue, customer_team, starts_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'setup', ?)
  `);

  const insertStep = db.prepare(`
    INSERT INTO step_states
      (game_id, step_id, seq, phase, track_key, prefix, name, cat, input, output, template_note,
       owners_json, default_owners_json, status, activated_at, completed_at, actor, note)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL)
  `);

  const insertActivity = db.prepare(`
    INSERT INTO activity_log (game_id, ts, action) VALUES (?, ?, 'event.created')
  `);

  db.transaction(() => {
    insertGame.run(gameId, name, sport || null, venue || null, customerTeam || null, startsAt || null, now);
    for (const s of steps) {
      insertStep.run(
        gameId, s.stepId, s.seq, s.phase, s.trackKey, s.prefix, s.name,
        s.cat, s.input, s.output, s.note,
        JSON.stringify(s.owners), JSON.stringify(s.defaultOwners)
      );
    }
    insertActivity.run(gameId, now);
  })();

  const event = fetchEvent(db, gameId);

  // Fire-and-forget: post the pinned status to Slack; when it resolves,
  // persist the message ts so subsequent updates can edit in place.
  slack.postPinnedStatus(gameId, event)
    .then(ts => {
      if (!ts) return;
      try {
        db.prepare('UPDATE games SET pinned_slack_message_ts=? WHERE id=?').run(ts, gameId);
      } catch (e) {
        console.error('[slack] persist pinnedTs failed:', e.message);
      }
    })
    .catch(err => console.error('[slack] postPinnedStatus chain failed:', err.message));

  res.status(201).json(event);
});

// ── PATCH /api/games/:gameId ──────────────────────────────────────────────────

router.patch('/:gameId', (req, res) => {
  const db     = getDb();
  const { gameId } = req.params;
  const exists = db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId);
  if (!exists) return res.status(404).json({ error: 'event not found' });

  const allowed = ['name','sport','venue','customer_team','starts_at','status',
                   'started_at','completed_at','pinned_slack_message_ts'];
  const sets    = [];
  const vals    = [];

  // Accept camelCase or snake_case from client
  const camelToSnake = {
    customerTeam:        'customer_team',
    startsAt:            'starts_at',
    startedAt:           'started_at',
    completedAt:         'completed_at',
    pinnedSlackMessageTs:'pinned_slack_message_ts',
  };

  for (const [k, v] of Object.entries(req.body)) {
    const col = camelToSnake[k] || k;
    if (!allowed.includes(col)) continue;
    sets.push(`${col} = ?`);
    vals.push(v);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'no patchable fields' });

  db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).run(...vals, gameId);
  db.prepare(`INSERT INTO activity_log (game_id, ts, action, payload) VALUES (?, ?, 'event.updated', ?)`)
    .run(gameId, Date.now(), JSON.stringify(req.body));

  res.json(fetchEvent(db, gameId));
});

// ── POST /api/games/:gameId/end ───────────────────────────────────────────────

router.post('/:gameId/end', (req, res) => {
  const db     = getDb();
  const { gameId } = req.params;
  const exists = db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId);
  if (!exists) return res.status(404).json({ error: 'event not found' });

  const now = Date.now();
  db.prepare("UPDATE games SET status='complete', completed_at=? WHERE id=?").run(now, gameId);
  db.prepare("INSERT INTO activity_log (game_id, ts, action) VALUES (?, ?, 'event.ended')").run(gameId, now);

  const event   = fetchEvent(db, gameId);
  const elapsed = (event.completedAt && event.startedAt) ? (event.completedAt - event.startedAt) : 0;
  slack.postStreamLive(gameId, event.pinnedSlackMessageTs, event, elapsed);

  res.json(event);
});

// ── POST /api/games/:gameId/archive ──────────────────────────────────────────

router.post('/:gameId/archive', (req, res) => {
  const db     = getDb();
  const { gameId } = req.params;
  const exists = db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId);
  if (!exists) return res.status(404).json({ error: 'event not found' });

  db.prepare("UPDATE games SET status='archived' WHERE id=?").run(gameId);
  db.prepare("INSERT INTO activity_log (game_id, ts, action) VALUES (?, ?, 'event.archived')").run(gameId, Date.now());
  res.json(fetchEvent(db, gameId));
});

// ── POST /api/games/:gameId/steps/:stepId/transition ─────────────────────────

const VALID_TRANSITIONS = new Set(['activate','complete','flag','block','resolve','deactivate','undo']);

router.post('/:gameId/steps/:stepId/transition', (req, res) => {
  const db = getDb();
  const { gameId, stepId } = req.params;
  const { transition, payload = {} } = req.body;

  if (!VALID_TRANSITIONS.has(transition)) {
    return res.status(400).json({ error: `unknown transition: ${transition}` });
  }

  const gameRow = db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId);
  if (!gameRow) return res.status(404).json({ error: 'event not found' });

  const stepRow = db.prepare('SELECT * FROM step_states WHERE game_id=? AND step_id=?').get(gameId, stepId);
  if (!stepRow) return res.status(404).json({ error: 'step not found' });

  const now = Date.now();
  let update;

  switch (transition) {
    case 'activate':
      update = { status: 'active', activated_at: now, completed_at: null };
      break;
    case 'complete':
      update = { status: 'complete', completed_at: now };
      break;
    case 'flag':
      update = { status: 'flagged', note: payload.note || null };
      _insertIssueEvent(db, gameId, stepId, 'flag', now);
      if (payload.note) _insertNote(db, gameId, stepId, 'flag', payload.note);
      break;
    case 'block':
      update = { status: 'blocked', note: payload.note || null };
      _insertIssueEvent(db, gameId, stepId, 'block', now);
      if (payload.note) _insertNote(db, gameId, stepId, 'block', payload.note);
      break;
    case 'resolve':
      update = { status: 'complete', completed_at: now };
      _resolveIssueEvent(db, gameId, stepId, now);
      break;
    case 'deactivate':
      update = { status: 'pending', activated_at: null };
      break;
    case 'undo':
      update = { status: 'pending', activated_at: null, completed_at: null, note: null };
      break;
  }

  const sets = Object.keys(update).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(update), gameId, stepId];
  db.prepare(`UPDATE step_states SET ${sets} WHERE game_id=? AND step_id=?`).run(...vals);

  db.prepare(`INSERT INTO activity_log (game_id, ts, action, step_id, actor, payload)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(gameId, now, `step.${transition}`, stepId, payload.actor || null, JSON.stringify(payload));

  const updated = db.prepare('SELECT * FROM step_states WHERE game_id=? AND step_id=?').get(gameId, stepId);

  _notifyTransitionAsync(gameId, stepId, transition, payload);

  res.json(rowToStep(updated));
});

function _insertNote(db, gameId, stepId, type, text) {
  db.prepare('INSERT INTO step_notes (game_id, step_id, type, text, created_at) VALUES (?,?,?,?,?)')
    .run(gameId, stepId, type, text, Date.now());
}

function _insertIssueEvent(db, gameId, stepId, type, startedAt) {
  // Only open a new issue event if there isn't already an open one for this step
  const open = db.prepare(
    "SELECT id FROM issue_events WHERE game_id=? AND step_id=? AND resolved_at IS NULL"
  ).get(gameId, stepId);
  if (!open) {
    db.prepare('INSERT INTO issue_events (game_id, step_id, type, started_at) VALUES (?,?,?,?)')
      .run(gameId, stepId, type, startedAt);
  }
}

function _resolveIssueEvent(db, gameId, stepId, resolvedAt) {
  db.prepare(
    "UPDATE issue_events SET resolved_at=? WHERE game_id=? AND step_id=? AND resolved_at IS NULL"
  ).run(resolvedAt, gameId, stepId);
}

// ── PATCH /api/games/:gameId/steps/:stepId/owners ────────────────────────────

router.patch('/:gameId/steps/:stepId/owners', (req, res) => {
  const db = getDb();
  const { gameId, stepId } = req.params;
  const { owners } = req.body;

  if (!Array.isArray(owners)) return res.status(400).json({ error: 'owners must be an array' });

  const stepRow = db.prepare('SELECT 1 FROM step_states WHERE game_id=? AND step_id=?').get(gameId, stepId);
  if (!stepRow) return res.status(404).json({ error: 'step not found' });

  db.prepare('UPDATE step_states SET owners_json=? WHERE game_id=? AND step_id=?')
    .run(JSON.stringify(owners), gameId, stepId);
  db.prepare("INSERT INTO activity_log (game_id, ts, action, step_id, payload) VALUES (?,?,?,?,?)")
    .run(gameId, Date.now(), 'step.owners', stepId, JSON.stringify({ owners }));

  const updated = db.prepare('SELECT * FROM step_states WHERE game_id=? AND step_id=?').get(gameId, stepId);
  res.json(rowToStep(updated));
});

// ── GET /api/attention/:userName ──────────────────────────────────────────────

router.get('/attention/:userName', (req, res) => {
  const db = getDb();
  const { userName } = req.params;

  const activeGames = db.prepare(
    "SELECT id, name FROM games WHERE status IN ('setup','live')"
  ).all();

  const items = [];
  for (const g of activeGames) {
    const steps = db.prepare(
      "SELECT * FROM step_states WHERE game_id=? AND status IN ('active','flagged','blocked')"
    ).all(g.id);
    for (const s of steps) {
      const owners = JSON.parse(s.owners_json || '[]');
      if (!owners.includes(userName)) continue;
      items.push({
        gameId:    g.id,
        eventName: g.name,
        stepId:    s.step_id,
        stepName:  s.name,
        status:    s.status,
      });
    }
  }
  res.json(items);
});

// NOTE: /api/attention/:userName is mounted under /api/games in index.js,
// but the attention route needs to be accessible at /api/attention/:userName.
// index.js mounts this router at /api/games — the attention endpoint is
// handled separately in index.js to keep routing clean.

module.exports = router;
