'use strict';

const { logWithTimestamp } = require('../utils');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache: userId -> { username, displayName, avatarUrl, cachedAt }
const memoryCache = new Map();

let _db = null;

/**
 * Call once at bot startup to pre-load DB entries into memory.
 * @param {import('better-sqlite3').Database} db
 */
function loadCacheFromDb(db) {
    _db = db;
    const rows = db.prepare('SELECT * FROM user_cache').all();
    for (const row of rows) {
        memoryCache.set(row.user_id, {
            username: row.username,
            displayName: row.display_name,
            avatarUrl: row.avatar_url,
            cachedAt: row.cached_at,
        });
    }
    logWithTimestamp(`User cache loaded: ${rows.length} entries`, 'STARTUP');
}

/**
 * Persist a user entry to DB (upsert).
 */
function persistToDb(userId, entry) {
    if (!_db) return;
    try {
        _db.prepare(`
            INSERT OR REPLACE INTO user_cache (user_id, username, display_name, avatar_url, cached_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, entry.username, entry.displayName, entry.avatarUrl, entry.cachedAt);
    } catch (err) {
        logWithTimestamp(`Failed to persist user cache for ${userId}: ${err.message}`, 'ERROR');
    }
}

/**
 * Fetch a user from Discord API and cache it.
 * @param {string} userId
 * @param {import('discord.js').Client} client
 * @returns {Promise<{userId: string, username: string, displayName: string, avatarUrl: string}>}
 */
async function fetchAndCache(userId, client) {
    const user = await client.users.fetch(userId);
    const entry = {
        username: user.username,
        displayName: user.displayName || user.globalName || user.username,
        avatarUrl: user.displayAvatarURL({ size: 64 }),
        cachedAt: Date.now(),
    };
    memoryCache.set(userId, entry);
    persistToDb(userId, entry);
    return { userId, ...entry };
}

/**
 * Get user info, using in-memory cache first, then DB, then Discord API.
 * @param {string} userId
 * @param {import('discord.js').Client} client
 * @returns {Promise<{userId: string, username: string, displayName: string, avatarUrl: string}>}
 */
async function getUserInfo(userId, client) {
    const now = Date.now();

    const cached = memoryCache.get(userId);
    if (cached && now - cached.cachedAt < TTL_MS) {
        return { userId, username: cached.username, displayName: cached.displayName, avatarUrl: cached.avatarUrl };
    }

    // Cache miss or stale — fetch from Discord
    try {
        return await fetchAndCache(userId, client);
    } catch (err) {
        logWithTimestamp(`Failed to fetch user ${userId}: ${err.message}`, 'WARN');
        // Return stale data if available rather than nothing
        if (cached) {
            return { userId, username: cached.username, displayName: cached.displayName, avatarUrl: cached.avatarUrl };
        }
        return { userId, username: userId, displayName: userId, avatarUrl: null };
    }
}

module.exports = { loadCacheFromDb, getUserInfo };
