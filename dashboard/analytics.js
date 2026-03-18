'use strict';

/**
 * All analytics functions take a better-sqlite3 db instance (read-only from dashboard).
 * multi_vote_mode options: highest | lowest | average | ignore
 */

/**
 * @param {string} timeframe  '24h' | '7d' | '30d' | '90d' | 'all'
 * @returns {{ startMs: number, endMs: number }}
 */
function getTimeRange(timeframe) {
    const endMs = Date.now();
    const MS = {
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
        '90d': 90 * 24 * 60 * 60 * 1000,
    };
    const startMs = MS[timeframe] ? endMs - MS[timeframe] : 0;
    return { startMs, endMs };
}

/**
 * Read multi_vote_mode from settings table.
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
function getMultiVoteMode(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'multi_vote_mode'").get();
    if (!row) return 'highest';
    try {
        const parsed = JSON.parse(row.value);
        return typeof parsed === 'string' ? parsed : 'highest';
    } catch {
        return row.value || 'highest';
    }
}

/**
 * Returns top voted users.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} limit
 * @returns {Array<{authorId, displayName, avatarUrl, score, postCount}>}
 */
function getTopVotedUsers(db, startMs, endMs, limit = 50) {
    const mode = getMultiVoteMode(db);

    let aggregateExpr;
    switch (mode) {
        case 'lowest':
            aggregateExpr = 'SUM(per_voter.min_val)';
            break;
        case 'average':
            aggregateExpr = 'SUM(per_voter.avg_val)';
            break;
        case 'ignore':
            aggregateExpr = 'COUNT(per_voter.voter_id)';  // sum of distinct voters per post
            break;
        case 'highest':
        default:
            aggregateExpr = 'SUM(per_voter.max_val)';
    }

    let innerSelect;
    switch (mode) {
        case 'lowest':
            innerSelect = 'MIN(v.vote_value) AS min_val, 0 AS max_val, 0 AS avg_val';
            break;
        case 'average':
            innerSelect = '0 AS min_val, 0 AS max_val, AVG(v.vote_value) AS avg_val';
            break;
        case 'ignore':
            innerSelect = '0 AS min_val, 0 AS max_val, 0 AS avg_val';
            break;
        case 'highest':
        default:
            innerSelect = '0 AS min_val, MAX(v.vote_value) AS max_val, 0 AS avg_val';
    }

    const sql = `
        SELECT
            p.author_id           AS authorId,
            COALESCE(uc.display_name, uc.username, p.author_id) AS displayName,
            uc.avatar_url         AS avatarUrl,
            ${aggregateExpr}      AS score,
            COUNT(DISTINCT p.message_id) AS postCount
        FROM posts p
        JOIN (
            SELECT
                v.message_id,
                v.voter_id,
                ${innerSelect}
            FROM votes v
            JOIN posts pp ON pp.message_id = v.message_id
            WHERE v.voted_at BETWEEN ? AND ?
              AND pp.deleted = 0
            GROUP BY v.message_id, v.voter_id
        ) AS per_voter ON per_voter.message_id = p.message_id
        LEFT JOIN user_cache uc ON uc.user_id = p.author_id
        WHERE p.deleted = 0
          AND p.posted_at BETWEEN ? AND ?
        GROUP BY p.author_id
        ORDER BY score DESC
        LIMIT ?
    `;

    return db.prepare(sql).all(startMs, endMs, startMs, endMs, limit);
}

/**
 * Returns top voters (by number of votes cast).
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} limit
 * @returns {Array<{voterId, displayName, avatarUrl, votesCast}>}
 */
function getTopVoters(db, startMs, endMs, limit = 50) {
    const sql = `
        SELECT
            v.voter_id            AS voterId,
            COALESCE(uc.display_name, uc.username, v.voter_id) AS displayName,
            uc.avatar_url         AS avatarUrl,
            COUNT(*)              AS votesCast
        FROM votes v
        LEFT JOIN user_cache uc ON uc.user_id = v.voter_id
        WHERE v.voted_at BETWEEN ? AND ?
        GROUP BY v.voter_id
        ORDER BY votesCast DESC
        LIMIT ?
    `;
    return db.prepare(sql).all(startMs, endMs, limit);
}

/**
 * Returns paginated posts with their total scores.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} page  (1-based)
 * @param {number} pageSize
 * @returns {Array<{messageId, threadId, guildId, authorId, displayName, content, postedAt, deleted, totalScore, voteCount}>}
 */
function getPosts(db, startMs, endMs, page = 1, pageSize = 20) {
    const mode = getMultiVoteMode(db);
    const offset = (page - 1) * pageSize;

    let aggregateExpr;
    switch (mode) {
        case 'lowest':
            aggregateExpr = 'SUM(per_voter.min_val)';
            break;
        case 'average':
            aggregateExpr = 'SUM(per_voter.avg_val)';
            break;
        case 'ignore':
            aggregateExpr = 'COUNT(DISTINCT per_voter.voter_id)';
            break;
        case 'highest':
        default:
            aggregateExpr = 'SUM(per_voter.max_val)';
    }

    let innerSelect;
    switch (mode) {
        case 'lowest':
            innerSelect = 'MIN(v.vote_value) AS min_val, 0 AS max_val, 0 AS avg_val';
            break;
        case 'average':
            innerSelect = '0 AS min_val, 0 AS max_val, AVG(v.vote_value) AS avg_val';
            break;
        case 'ignore':
            innerSelect = '0 AS min_val, 0 AS max_val, 0 AS avg_val';
            break;
        case 'highest':
        default:
            innerSelect = '0 AS min_val, MAX(v.vote_value) AS max_val, 0 AS avg_val';
    }

    const sql = `
        SELECT
            p.message_id          AS messageId,
            p.thread_id           AS threadId,
            p.guild_id            AS guildId,
            p.author_id           AS authorId,
            COALESCE(uc.display_name, uc.username, p.author_id) AS displayName,
            p.content             AS content,
            p.posted_at           AS postedAt,
            p.deleted             AS deleted,
            COALESCE(${aggregateExpr}, 0) AS totalScore,
            COUNT(DISTINCT per_voter.voter_id) AS voteCount
        FROM posts p
        LEFT JOIN (
            SELECT
                v.message_id,
                v.voter_id,
                ${innerSelect}
            FROM votes v
            GROUP BY v.message_id, v.voter_id
        ) AS per_voter ON per_voter.message_id = p.message_id
        LEFT JOIN user_cache uc ON uc.user_id = p.author_id
        WHERE p.posted_at BETWEEN ? AND ?
        GROUP BY p.message_id
        ORDER BY p.posted_at DESC
        LIMIT ? OFFSET ?
    `;

    return db.prepare(sql).all(startMs, endMs, pageSize, offset);
}

/**
 * Returns the total count of posts matching the time range (for pagination).
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @returns {number}
 */
function getPostsCount(db, startMs, endMs) {
    const row = db.prepare(
        'SELECT COUNT(*) AS cnt FROM posts WHERE posted_at BETWEEN ? AND ?'
    ).get(startMs, endMs);
    return row ? row.cnt : 0;
}

/**
 * Returns overall stats.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @returns {{totalPosts, totalVotes, totalVoters, totalAuthors}}
 */
function getStats(db, startMs, endMs) {
    const posts = db.prepare(
        'SELECT COUNT(*) AS cnt FROM posts WHERE posted_at BETWEEN ? AND ? AND deleted = 0'
    ).get(startMs, endMs);

    const votes = db.prepare(
        'SELECT COUNT(*) AS cnt, COUNT(DISTINCT voter_id) AS voters FROM votes WHERE voted_at BETWEEN ? AND ?'
    ).get(startMs, endMs);

    const authors = db.prepare(
        'SELECT COUNT(DISTINCT author_id) AS cnt FROM posts WHERE posted_at BETWEEN ? AND ? AND deleted = 0'
    ).get(startMs, endMs);

    return {
        totalPosts: posts ? posts.cnt : 0,
        totalVotes: votes ? votes.cnt : 0,
        totalVoters: votes ? votes.voters : 0,
        totalAuthors: authors ? authors.cnt : 0,
    };
}

module.exports = { getTimeRange, getTopVotedUsers, getTopVoters, getPosts, getPostsCount, getStats };
