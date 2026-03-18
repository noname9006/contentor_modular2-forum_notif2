'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const { logWithTimestamp } = require('../utils');

const DB_PATH = process.env.VOTING_DB_PATH || path.join(process.cwd(), 'voting.db');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  message_id        TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL,
  forum_channel_id  TEXT NOT NULL,
  guild_id          TEXT NOT NULL,
  author_id         TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  highest_role_id   TEXT,
  content           TEXT,
  posted_at         INTEGER NOT NULL,
  deleted           INTEGER DEFAULT 0,
  deleted_at        INTEGER
);

CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  voter_id      TEXT NOT NULL,
  voter_role_id TEXT,
  vote_value    INTEGER NOT NULL CHECK(vote_value BETWEEN 0 AND 4),
  voted_at      INTEGER NOT NULL,
  UNIQUE(message_id, voter_id, vote_value),
  FOREIGN KEY(message_id) REFERENCES posts(message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_cache (
  user_id      TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  cached_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_votes_author    ON votes(author_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter     ON votes(voter_id);
CREATE INDEX IF NOT EXISTS idx_votes_voted_at  ON votes(voted_at);
CREATE INDEX IF NOT EXISTS idx_posts_author    ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);
CREATE INDEX IF NOT EXISTS idx_posts_forum     ON posts(forum_channel_id);
`;

const DEFAULT_SETTINGS = [
    ['tracked_forum_id', ''],
    ['tracked_roles', '[]'],
    ['multi_vote_mode', 'highest'],
    ['vote_emojis', JSON.stringify(['🧊', '🌤️', '⚡', '🔥', '💥'])],
    ['dashboard_password_hash', ''],
];

async function initDb() {
    db = new Database(DB_PATH);

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create tables and indexes
    db.exec(SCHEMA);

    // Seed default settings (INSERT OR IGNORE so existing values are preserved)
    const insertSetting = db.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    const seedTx = db.transaction(() => {
        for (const [key, value] of DEFAULT_SETTINGS) {
            insertSetting.run(key, value);
        }
    });
    seedTx();

    // If dashboard_password_hash is empty and DASHBOARD_PASSWORD env is set, hash it now
    const currentHash = getSetting('dashboard_password_hash');
    if (!currentHash && process.env.DASHBOARD_PASSWORD) {
        const hash = await bcrypt.hash(process.env.DASHBOARD_PASSWORD, 12);
        setSetting('dashboard_password_hash', hash);
        logWithTimestamp('Dashboard password hash initialized from DASHBOARD_PASSWORD env', 'STARTUP');
    }

    logWithTimestamp(`Database initialized at ${DB_PATH}`, 'STARTUP');
}

function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDb() first.');
    return db;
}

function getSetting(key) {
    if (!db) return null;
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch {
        return row.value;
    }
}

function setSetting(key, value) {
    if (!db) throw new Error('Database not initialized.');
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, serialized);
}

function getAllSettings() {
    if (!db) return {};
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
        try {
            result[row.key] = JSON.parse(row.value);
        } catch {
            result[row.key] = row.value;
        }
    }
    return result;
}

module.exports = { initDb, getDb, getSetting, setSetting, getAllSettings };
