// app/db.js
// SQLite database setup using better-sqlite3
// Tables: events, sessions, pos_transactions
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/store.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');      // better concurrent read performance
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');    // fast enough, safe enough
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    -- ── Events table ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS events (
      event_id        TEXT PRIMARY KEY,
      store_id        TEXT NOT NULL,
      camera_id       TEXT NOT NULL,
      visitor_id      TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      zone_id         TEXT,
      dwell_ms        INTEGER DEFAULT 0,
      is_staff        INTEGER DEFAULT 0,   -- 0 = customer, 1 = staff
      confidence      REAL NOT NULL,
      queue_depth     INTEGER,
      sku_zone        TEXT,
      session_seq     INTEGER,
      ingested_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_store_ts
      ON events(store_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_events_visitor
      ON events(visitor_id);

    CREATE INDEX IF NOT EXISTS idx_events_type
      ON events(store_id, event_type, timestamp);

    CREATE INDEX IF NOT EXISTS idx_events_zone
      ON events(store_id, zone_id, timestamp);

    -- ── Sessions table ────────────────────────────────────────────────────────
    -- One row per unique visit session (visitor_id + entry date)
    CREATE TABLE IF NOT EXISTS sessions (
      session_id      TEXT PRIMARY KEY,   -- visitor_id + ':' + date
      store_id        TEXT NOT NULL,
      visitor_id      TEXT NOT NULL,
      entry_time      TEXT,
      exit_time       TEXT,
      reentry_count   INTEGER DEFAULT 0,
      entered_billing INTEGER DEFAULT 0,
      purchased       INTEGER DEFAULT 0,
      is_staff        INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_store
      ON sessions(store_id, entry_time);

    CREATE INDEX IF NOT EXISTS idx_sessions_visitor
      ON sessions(visitor_id);

    -- ── POS transactions table ────────────────────────────────────────────────
   CREATE TABLE IF NOT EXISTS pos_transactions (
  order_id       TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL,
  order_date     TEXT NOT NULL,
  order_time     TEXT NOT NULL,
  order_datetime TEXT NOT NULL,
  total_amount   REAL NOT NULL,
  brand_name     TEXT,
  product_id     TEXT
);

    CREATE INDEX IF NOT EXISTS idx_pos_store_dt
      ON pos_transactions(store_id, order_datetime);

    -- ── Zone dwell aggregates (for fast heatmap queries) ──────────────────────
    CREATE TABLE IF NOT EXISTS zone_dwell (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id        TEXT NOT NULL,
      zone_id         TEXT NOT NULL,
      visitor_id      TEXT NOT NULL,
      dwell_ms        INTEGER DEFAULT 0,
      recorded_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dwell_store_zone
      ON zone_dwell(store_id, zone_id, recorded_at);
  `);
}

// ── Prepared statement helpers ────────────────────────────────────────────────

function insertEvent(db, event) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (event_id, store_id, camera_id, visitor_id, event_type, timestamp,
       zone_id, dwell_ms, is_staff, confidence, queue_depth, sku_zone, session_seq)
    VALUES
      (@event_id, @store_id, @camera_id, @visitor_id, @event_type, @timestamp,
       @zone_id, @dwell_ms, @is_staff, @confidence, @queue_depth, @sku_zone, @session_seq)
  `);
  return stmt.run({
    event_id: event.event_id,
    store_id: event.store_id,
    camera_id: event.camera_id,
    visitor_id: event.visitor_id,
    event_type: event.event_type,
    timestamp: event.timestamp,
    zone_id: event.zone_id || null,
    dwell_ms: event.dwell_ms || 0,
    is_staff: event.is_staff ? 1 : 0,
    confidence: event.confidence,
    queue_depth: event.metadata?.queue_depth ?? null,
    sku_zone: event.metadata?.sku_zone ?? null,
    session_seq: event.metadata?.session_seq ?? null
  });
}

function upsertSession(db, event) {
  const date = event.timestamp.slice(0, 10);
  const sessionId = `${event.visitor_id}:${date}`;

  if (event.event_type === 'ENTRY') {
    db.prepare(`
      INSERT INTO sessions (session_id, store_id, visitor_id, entry_time, is_staff)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        reentry_count = reentry_count + 1,
        updated_at = datetime('now')
    `).run(sessionId, event.store_id, event.visitor_id, event.timestamp, event.is_staff ? 1 : 0);
  }

  if (event.event_type === 'EXIT') {
    db.prepare(`
      UPDATE sessions SET exit_time = ?, updated_at = datetime('now')
      WHERE session_id = ?
    `).run(event.timestamp, sessionId);
  }

  if (event.event_type === 'BILLING_QUEUE_JOIN') {
    db.prepare(`
      UPDATE sessions SET entered_billing = 1, updated_at = datetime('now')
      WHERE session_id = ?
    `).run(sessionId);
  }
}

module.exports = { getDb, insertEvent, upsertSession };
