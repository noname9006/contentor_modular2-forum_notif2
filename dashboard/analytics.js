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
 * Returns Map<roleId, weight> from the tracked_roles setting.
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, number>}
 */
function getRoleWeightMap(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tracked_roles'").get();
    if (!row) return new Map();
    try {
        const roles = JSON.parse(row.value);
        if (!Array.isArray(roles)) return new Map();
        return new Map(roles.map(r => [String(r.id), typeof r.weight === 'number' ? r.weight : 1]));
    } catch { return new Map(); }
}

/**
 * Returns array[5] of weights from vote_emoji_weights setting.
 * @param {import('better-sqlite3').Database} db
 * @returns {number[]}
 */
function getEmojiWeights(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'vote_emoji_weights'").get();
    if (!row) return [0, 1, 2, 3, 4];
    try {
        const w = JSON.parse(row.value);
        return Array.isArray(w) && w.length === 5 ? w : [0, 1, 2, 3, 4];
    } catch { return [0, 1, 2, 3, 4]; }
}

/**
 * Build the inner SQL for resolved vote rows.
 * Returns rows: { message_id, author_id, voter_id, voter_role_id, resolved_value }
 * @param {string} mode
 * @param {number} startMs
 * @param {number} endMs
 * @param {string[]} [threadIds]  optional list of thread_id values to filter
 * @returns {{ sql: string, params: any[] }}
 */
function buildResolvedVotesSQL(mode, startMs, endMs, threadIds) {
    const threadFilter = threadIds && threadIds.length > 0
        ? `AND pp.thread_id IN (${threadIds.map(() => '?').join(',')})`
        : '';

    let aggregateExpr;
    switch (mode) {
        case 'lowest':  aggregateExpr = 'MIN(v.vote_value)'; break;
        case 'average': aggregateExpr = 'AVG(v.vote_value)'; break;
        case 'ignore':  aggregateExpr = 'CASE WHEN COUNT(v.vote_value) = 1 THEN MIN(v.vote_value) ELSE NULL END'; break;
        case 'highest':
        default:        aggregateExpr = 'MAX(v.vote_value)';
    }

    const sql = `
        SELECT
            v.message_id      AS message_id,
            pp.author_id      AS author_id,
            v.voter_id        AS voter_id,
            v.voter_role_id   AS voter_role_id,
            ${aggregateExpr}  AS resolved_value
        FROM votes v
        JOIN posts pp ON pp.message_id = v.message_id
        WHERE v.voted_at BETWEEN ? AND ?
          AND pp.deleted = 0
          ${threadFilter}
        GROUP BY v.message_id, v.voter_id
    `;

    const params = [startMs, endMs, ...(threadIds || [])];
    return { sql, params };
}

/**
 * Returns top voted users using role-weighted scoring.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} limit
 * @returns {Array<{authorId, displayName, avatarUrl, score, postCount}>}
 */
function getTopVotedUsers(db, startMs, endMs, limit = 50) {
    return _getTopVotedUsersFiltered(db, startMs, endMs, null, limit);
}

/**
 * Returns top voted users filtered to specific thread IDs.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {string[]} threadIds
 * @param {number} limit
 * @returns {Array<{authorId, displayName, avatarUrl, score, postCount}>}
 */
function getTopVotedUsersByThread(db, startMs, endMs, threadIds, limit = 50) {
    return _getTopVotedUsersFiltered(db, startMs, endMs, threadIds, limit);
}

/**
 * Internal implementation for top voted users with optional thread filter.
 */
function _getTopVotedUsersFiltered(db, startMs, endMs, threadIds, limit) {
    const mode = getMultiVoteMode(db);
    const roleWeightMap = getRoleWeightMap(db);
    const emojiWeights = getEmojiWeights(db);

    const { sql: innerSql, params: innerParams } = buildResolvedVotesSQL(mode, startMs, endMs, threadIds);

    // Also fetch display info for authors
    const threadFilter = threadIds && threadIds.length > 0
        ? `AND p.thread_id IN (${threadIds.map(() => '?').join(',')})`
        : '';
    const outerSql = `
        SELECT
            p.message_id          AS message_id,
            p.author_id           AS author_id,
            COALESCE(uc.display_name, uc.username, p.author_id) AS displayName,
            uc.avatar_url         AS avatarUrl
        FROM posts p
        LEFT JOIN user_cache uc ON uc.user_id = p.author_id
        WHERE p.deleted = 0
          AND p.posted_at BETWEEN ? AND ?
          ${threadFilter}
        GROUP BY p.author_id, p.message_id
    `;
    const outerParams = [startMs, endMs, ...(threadIds || [])];

    const resolvedRows = db.prepare(innerSql).all(...innerParams);
    const postRows = db.prepare(outerSql).all(...outerParams);

    // Build author info map (last display info per author)
    const authorInfoMap = new Map();
    for (const row of postRows) {
        authorInfoMap.set(row.author_id, { displayName: row.displayName, avatarUrl: row.avatarUrl });
    }

    // Count distinct posts per author from postRows
    const authorPostCount = new Map();
    for (const row of postRows) {
        authorPostCount.set(row.author_id, (authorPostCount.get(row.author_id) || new Set()).add(row.message_id));
    }

    // Accumulate weighted scores per author
    const authorScores = new Map();
    for (const row of resolvedRows) {
        if (row.resolved_value === null) continue; // ignore mode filtered
        const roleWeight = row.voter_role_id ? (roleWeightMap.get(String(row.voter_role_id)) ?? 0) : 0;
        const emojiWeight = emojiWeights[Math.round(row.resolved_value)] ?? 0;
        const contribution = roleWeight * emojiWeight;
        authorScores.set(row.author_id, (authorScores.get(row.author_id) || 0) + contribution);
    }

    // Merge into result array
    const result = [];
    for (const [authorId, info] of authorInfoMap) {
        const postSet = authorPostCount.get(authorId);
        result.push({
            authorId,
            displayName: info.displayName,
            avatarUrl: info.avatarUrl,
            score: authorScores.get(authorId) || 0,
            postCount: postSet ? postSet.size : 0,
        });
    }

    result.sort((a, b) => b.score - a.score);
    return result.slice(0, limit);
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
 * Returns paginated posts with their total role-weighted scores.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} page  (1-based)
 * @param {number} pageSize
 * @returns {Array<{messageId, threadId, guildId, authorId, displayName, content, postedAt, deleted, totalScore, voteCount}>}
 */
function getPosts(db, startMs, endMs, page = 1, pageSize = 20) {
    const mode = getMultiVoteMode(db);
    const roleWeightMap = getRoleWeightMap(db);
    const emojiWeights = getEmojiWeights(db);
    const offset = (page - 1) * pageSize;

    // Fetch all posts in range
    const postsSql = `
        SELECT
            p.message_id          AS messageId,
            p.thread_id           AS threadId,
            p.guild_id            AS guildId,
            p.author_id           AS authorId,
            COALESCE(uc.display_name, uc.username, p.author_id) AS displayName,
            p.content             AS content,
            p.posted_at           AS postedAt,
            p.deleted             AS deleted
        FROM posts p
        LEFT JOIN user_cache uc ON uc.user_id = p.author_id
        WHERE p.posted_at BETWEEN ? AND ?
        ORDER BY p.posted_at DESC
        LIMIT ? OFFSET ?
    `;
    const posts = db.prepare(postsSql).all(startMs, endMs, pageSize, offset);
    if (posts.length === 0) return [];

    const messageIds = posts.map(p => p.messageId);
    const placeholders = messageIds.map(() => '?').join(',');

    // Fetch resolved votes for these posts
    let aggregateExpr;
    switch (mode) {
        case 'lowest':  aggregateExpr = 'MIN(v.vote_value)'; break;
        case 'average': aggregateExpr = 'AVG(v.vote_value)'; break;
        case 'ignore':  aggregateExpr = 'CASE WHEN COUNT(v.vote_value) = 1 THEN MIN(v.vote_value) ELSE NULL END'; break;
        case 'highest':
        default:        aggregateExpr = 'MAX(v.vote_value)';
    }

    const votesSql = `
        SELECT
            v.message_id    AS message_id,
            v.voter_id      AS voter_id,
            v.voter_role_id AS voter_role_id,
            ${aggregateExpr} AS resolved_value
        FROM votes v
        WHERE v.message_id IN (${placeholders})
        GROUP BY v.message_id, v.voter_id
    `;
    const voteRows = db.prepare(votesSql).all(...messageIds);

    // Aggregate scores per message
    const scoreMap = new Map();
    const voterCountMap = new Map();
    for (const row of voteRows) {
        const voters = voterCountMap.get(row.message_id) || new Set();
        voters.add(row.voter_id);
        voterCountMap.set(row.message_id, voters);

        if (row.resolved_value === null) continue;
        const roleWeight = row.voter_role_id ? (roleWeightMap.get(String(row.voter_role_id)) ?? 0) : 0;
        const emojiWeight = emojiWeights[Math.round(row.resolved_value)] ?? 0;
        const contribution = roleWeight * emojiWeight;
        scoreMap.set(row.message_id, (scoreMap.get(row.message_id) || 0) + contribution);
    }

    return posts.map(p => ({
        ...p,
        totalScore: scoreMap.get(p.messageId) || 0,
        voteCount: voterCountMap.has(p.messageId) ? voterCountMap.get(p.messageId).size : 0,
    }));
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
    return _getStatsFiltered(db, startMs, endMs, null);
}

/**
 * Returns stats filtered to specific thread IDs.
 * @param {import('better-sqlite3').Database} db
 * @param {number} startMs
 * @param {number} endMs
 * @param {string[]} threadIds
 * @returns {{totalPosts, totalVotes, totalVoters, totalAuthors}}
 */
function getStatsByThread(db, startMs, endMs, threadIds) {
    return _getStatsFiltered(db, startMs, endMs, threadIds);
}

/**
 * Internal implementation for stats with optional thread filter.
 */
function _getStatsFiltered(db, startMs, endMs, threadIds) {
    const threadFilter = threadIds && threadIds.length > 0
        ? `AND thread_id IN (${threadIds.map(() => '?').join(',')})`
        : '';
    const threadParams = threadIds && threadIds.length > 0 ? threadIds : [];

    const posts = db.prepare(
        `SELECT COUNT(*) AS cnt FROM posts WHERE posted_at BETWEEN ? AND ? AND deleted = 0 ${threadFilter}`
    ).get(startMs, endMs, ...threadParams);

    const votes = db.prepare(
        `SELECT COUNT(*) AS cnt, COUNT(DISTINCT voter_id) AS voters
         FROM votes
         WHERE voted_at BETWEEN ? AND ?
         ${threadFilter
            ? `AND message_id IN (SELECT message_id FROM posts WHERE thread_id IN (${threadIds.map(() => '?').join(',')}))`
            : ''}`
    ).get(startMs, endMs, ...threadParams);

    const authors = db.prepare(
        `SELECT COUNT(DISTINCT author_id) AS cnt FROM posts WHERE posted_at BETWEEN ? AND ? AND deleted = 0 ${threadFilter}`
    ).get(startMs, endMs, ...threadParams);

    return {
        totalPosts: posts ? posts.cnt : 0,
        totalVotes: votes ? votes.cnt : 0,
        totalVoters: votes ? votes.voters : 0,
        totalAuthors: authors ? authors.cnt : 0,
    };
}

/**
 * Returns tracked thread names from settings.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id, name}>}
 */
function getTrackedThreadNames(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tracked_thread_ids'").get();
    if (!row) return [];
    try {
        const threads = JSON.parse(row.value);
        if (!Array.isArray(threads)) return [];
        return threads.map(t => ({ id: String(t.id || t), name: t.name || String(t.id || t) }));
    } catch { return []; }
}

module.exports = {
    getTimeRange,
    getTopVotedUsers,
    getTopVotedUsersByThread,
    getTopVoters,
    getPosts,
    getPostsCount,
    getStats,
    getStatsByThread,
    getTrackedThreadNames,
};
