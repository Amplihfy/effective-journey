import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CEMETERY_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.CEMETERY_DB || join(dataDir, 'cemetery.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema -----------------------------------------------------------------
// A "session" represents one connected logging session at the cemetery
// (a survey visit, a data-entry session, etc.). Each session holds many
// grave/burial records. Records are the searchable session data.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    operator    TEXT,
    device      TEXT,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    deceased_name TEXT NOT NULL,
    section       TEXT,
    plot          TEXT,
    birth_date    TEXT,
    death_date    TEXT,
    latitude      REAL,
    longitude     REAL,
    notes         TEXT,
    recorded_by   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id);
  CREATE INDEX IF NOT EXISTS idx_records_name ON records(deceased_name);

  -- Photos attached to a record, stored inline so they persist with the DB.
  CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id   INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    mime        TEXT NOT NULL,
    bytes       BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_photos_record ON photos(record_id);

  -- Full-text search over the human-readable fields of each record.
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    deceased_name, section, plot, notes, recorded_by,
    content='records', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, deceased_name, section, plot, notes, recorded_by)
    VALUES (new.id, new.deceased_name, new.section, new.plot, new.notes, new.recorded_by);
  END;

  CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, deceased_name, section, plot, notes, recorded_by)
    VALUES ('delete', old.id, old.deceased_name, old.section, old.plot, old.notes, old.recorded_by);
  END;

  CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, deceased_name, section, plot, notes, recorded_by)
    VALUES ('delete', old.id, old.deceased_name, old.section, old.plot, old.notes, old.recorded_by);
    INSERT INTO records_fts(rowid, deceased_name, section, plot, notes, recorded_by)
    VALUES (new.id, new.deceased_name, new.section, new.plot, new.notes, new.recorded_by);
  END;
`);

// --- Session helpers --------------------------------------------------------
export function createSession({ name, operator, device }) {
  const stmt = db.prepare(
    `INSERT INTO sessions (name, operator, device) VALUES (?, ?, ?)`
  );
  const info = stmt.run(name, operator ?? null, device ?? null);
  return getSession(info.lastInsertRowid);
}

export function getSession(id) {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function listSessions() {
  return db
    .prepare(
      `SELECT s.*, COUNT(r.id) AS record_count
       FROM sessions s
       LEFT JOIN records r ON r.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC`
    )
    .all();
}

export function endSession(id) {
  db.prepare(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run(id);
  return getSession(id);
}

// --- Record helpers ---------------------------------------------------------
const RECORD_FIELDS = [
  'deceased_name', 'section', 'plot', 'birth_date', 'death_date',
  'latitude', 'longitude', 'notes', 'recorded_by',
];

export function addRecord(sessionId, data) {
  if (!getSession(sessionId)) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (!data.deceased_name || !String(data.deceased_name).trim()) {
    throw new Error('deceased_name is required');
  }
  const values = RECORD_FIELDS.map((f) => (data[f] === undefined ? null : data[f]));
  const stmt = db.prepare(
    `INSERT INTO records (session_id, ${RECORD_FIELDS.join(', ')})
     VALUES (?, ${RECORD_FIELDS.map(() => '?').join(', ')})`
  );
  const info = stmt.run(sessionId, ...values);
  return getRecord(info.lastInsertRowid);
}

export function getRecord(id) {
  return db.prepare(`SELECT * FROM records WHERE id = ?`).get(id);
}

export function deleteRecord(id) {
  return db.prepare(`DELETE FROM records WHERE id = ?`).run(id).changes > 0;
}

/**
 * Search records. With a query string it uses FTS5; without one it returns the
 * most recent records. Optionally scope to a single session.
 */
export function searchRecords({ q, sessionId, limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Number(offset) || 0;

  if (q && q.trim()) {
    const match = ftsQuery(q);
    const params = { match, lim, off };
    let where = `records_fts MATCH @match`;
    if (sessionId) where += ` AND r.session_id = @sessionId`, (params.sessionId = sessionId);
    return db
      .prepare(
        `SELECT r.*, s.name AS session_name, bm25(records_fts) AS rank,
                (SELECT COUNT(*) FROM photos p WHERE p.record_id = r.id) AS photo_count
         FROM records_fts
         JOIN records r ON r.id = records_fts.rowid
         JOIN sessions s ON s.id = r.session_id
         WHERE ${where}
         ORDER BY rank
         LIMIT @lim OFFSET @off`
      )
      .all(params);
  }

  const params = { lim, off };
  let where = '1=1';
  if (sessionId) where += ` AND r.session_id = @sessionId`, (params.sessionId = sessionId);
  return db
    .prepare(
      `SELECT r.*, s.name AS session_name,
              (SELECT COUNT(*) FROM photos p WHERE p.record_id = r.id) AS photo_count
       FROM records r
       JOIN sessions s ON s.id = r.session_id
       WHERE ${where}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT @lim OFFSET @off`
    )
    .all(params);
}

// Turn free-text user input into a safe FTS5 prefix query.
function ftsQuery(q) {
  const tokens = q
    .toLowerCase()
    .replace(/["()*]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return '""';
  return tokens.map((t) => `${t}*`).join(' ');
}

// --- Photo helpers ----------------------------------------------------------
export function addPhoto(recordId, mime, buffer) {
  if (!getRecord(recordId)) throw new Error(`Record ${recordId} not found`);
  const info = db
    .prepare(`INSERT INTO photos (record_id, mime, bytes) VALUES (?, ?, ?)`)
    .run(recordId, mime, buffer);
  return { id: info.lastInsertRowid, record_id: recordId, mime };
}

export function getPhoto(id) {
  return db.prepare(`SELECT * FROM photos WHERE id = ?`).get(id);
}

export function listPhotos(recordId) {
  return db
    .prepare(`SELECT id, mime, created_at FROM photos WHERE record_id = ? ORDER BY id`)
    .all(recordId);
}

export function deletePhoto(id) {
  return db.prepare(`DELETE FROM photos WHERE id = ?`).run(id).changes > 0;
}

export function stats() {
  const sessions = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
  const records = db.prepare(`SELECT COUNT(*) AS n FROM records`).get().n;
  const sections = db
    .prepare(`SELECT COUNT(DISTINCT section) AS n FROM records WHERE section IS NOT NULL`)
    .get().n;
  return { sessions, records, sections };
}
