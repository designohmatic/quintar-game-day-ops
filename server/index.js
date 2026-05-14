'use strict';

require('dotenv').config({ path: '../.env.local' });

const express = require('express');
const cors    = require('cors');
const pino    = require('pino');

const { getDb }    = require('./db');
const gamesRouter  = require('./routes/games');
const rosterService = require('./roster-service');

const PORT      = parseInt(process.env.PORT || '3005', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level: LOG_LEVEL,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors()); // open in dev; tighten to CORS_ALLOWED_ORIGIN before prod

app.use(express.json());

app.use((req, _res, next) => {
  logger.debug({ method: req.method, url: req.url }, 'request');
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  let dbOk = false;
  try {
    getDb().prepare('SELECT 1').get();
    dbOk = true;
  } catch (_) {}

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status:  dbOk ? 'ok' : 'error',
    db:      dbOk ? 'ok' : 'error',
    uptime:  Math.floor(process.uptime()),
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/games', gamesRouter);

// Enriched roster (raw roster.json + live slackHandle from Slack users.info)
app.get('/api/roster', (req, res) => {
  res.json(rosterService.getRoster());
});

// Attention endpoint is NOT under /api/games/:gameId to avoid routing collision
app.get('/api/attention/:userName', (req, res) => {
  // Delegate to the games router handler inline
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

// ── 404 fallback ──────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `not found: ${req.method} ${req.url}` });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`quintar-ops server listening on :${PORT}`);
  // Warm the DB connection so first request isn't slow
  try { getDb(); logger.info('SQLite ready'); } catch (e) { logger.error(e, 'SQLite init failed'); }
  // Kick off roster enrichment in the background — first request to
  // /api/roster will see whatever's ready (raw roster.json initially,
  // enriched once users.info completes).
  rosterService.start()
    .then(r => logger.info(`roster enriched: ${r?.length || 0} entries`))
    .catch(e => logger.warn({ err: e.message }, 'roster enrichment failed'));
});
