'use strict';

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../data/ops.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      sport                  TEXT,
      venue                  TEXT,
      customer_team          TEXT,
      starts_at              TEXT,
      status                 TEXT NOT NULL DEFAULT 'setup',
      created_at             INTEGER NOT NULL,
      started_at             INTEGER,
      completed_at           INTEGER,
      pinned_slack_message_ts TEXT
    );

    CREATE TABLE IF NOT EXISTS step_states (
      game_id       TEXT NOT NULL REFERENCES games(id),
      step_id       TEXT NOT NULL,
      seq           INTEGER,
      phase         TEXT,
      track_key     TEXT,
      prefix        TEXT,
      name          TEXT,
      cat           TEXT,
      input         TEXT,
      output        TEXT,
      template_note TEXT,
      owners_json   TEXT NOT NULL DEFAULT '[]',
      default_owners_json TEXT NOT NULL DEFAULT '[]',
      status        TEXT NOT NULL DEFAULT 'pending',
      activated_at  INTEGER,
      completed_at  INTEGER,
      actor         TEXT,
      note          TEXT,
      user_note     TEXT,
      user_note_actor TEXT,
      user_note_updated_at INTEGER,
      PRIMARY KEY (game_id, step_id)
    );

    CREATE TABLE IF NOT EXISTS step_notes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id  TEXT NOT NULL REFERENCES games(id),
      step_id  TEXT NOT NULL,
      type     TEXT NOT NULL,
      text     TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS issue_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id     TEXT NOT NULL REFERENCES games(id),
      step_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS activation_chain (
      game_id           TEXT NOT NULL REFERENCES games(id),
      trigger_step_id   TEXT NOT NULL,
      activated_step_id TEXT NOT NULL,
      PRIMARY KEY (game_id, trigger_step_id, activated_step_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id  TEXT NOT NULL REFERENCES games(id),
      ts       INTEGER NOT NULL,
      action   TEXT NOT NULL,
      step_id  TEXT,
      actor    TEXT,
      payload  TEXT
    );
  `);

  // Migrations for DBs created before user-notes existed (prod has data already).
  // SQLite has no IF NOT EXISTS for ADD COLUMN, so swallow the duplicate-column error.
  for (const col of ['user_note TEXT', 'user_note_actor TEXT', 'user_note_updated_at INTEGER']) {
    try { _db.exec(`ALTER TABLE step_states ADD COLUMN ${col}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }

  return _db;
}

/**
 * Return a step_states row as a plain JS object with parsed owners arrays.
 */
function rowToStep(row) {
  if (!row) return null;
  return {
    stepId:        row.step_id,
    seq:           row.seq,
    phase:         row.phase,
    trackKey:      row.track_key,
    prefix:        row.prefix,
    name:          row.name,
    cat:           row.cat,
    input:         row.input,
    output:        row.output,
    note:          row.note,
    templateNote:  row.template_note,
    owners:        JSON.parse(row.owners_json || '[]'),
    defaultOwners: JSON.parse(row.default_owners_json || '[]'),
    status:        row.status,
    activatedAt:   row.activated_at,
    completedAt:   row.completed_at,
    actor:         row.actor,
    userNote:           row.user_note,
    userNoteActor:      row.user_note_actor,
    userNoteUpdatedAt:  row.user_note_updated_at,
  };
}

/**
 * Return a games row as a plain JS object with its steps[] included.
 */
function rowToEvent(gameRow, stepRows = []) {
  if (!gameRow) return null;
  return {
    gameId:               gameRow.id,
    name:                 gameRow.name,
    sport:                gameRow.sport,
    venue:                gameRow.venue,
    customerTeam:         gameRow.customer_team,
    startsAt:             gameRow.starts_at,
    status:               gameRow.status,
    createdAt:            gameRow.created_at,
    startedAt:            gameRow.started_at,
    completedAt:          gameRow.completed_at,
    pinnedSlackMessageTs: gameRow.pinned_slack_message_ts,
    steps:                stepRows.map(rowToStep),
  };
}

module.exports = { getDb, rowToStep, rowToEvent };
