'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');

const {
    getTimeRange,
    getTopVotedUsers,
    getTopVoters,
    getPosts,
    getPostsCount,
    getStats,
} = require('./analytics');

// ── Env validation ─────────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
    console.error('[FATAL] SESSION_SECRET environment variable is required');
    process.exit(1);
}

const PORT = parseInt(process.env.DASHBOARD_PORT) || 3001;
const DB_PATH = process.env.VOTING_DB_PATH || path.join(__dirname, '..', 'voting.db');

// Open DB in read-only mode for reads. A separate writable connection handles settings writes.
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// Single writable connection for settings mutations — reused across requests to avoid locking churn.
const dbWrite = new Database(DB_PATH);
dbWrite.pragma('journal_mode = WAL');

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Session ────────────────────────────────────────────────────────────────────
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
}));

// ── CSRF protection ────────────────────────────────────────────────────────────
// Generate a per-session CSRF token using the built-in crypto module.
const crypto = require('crypto');

function generateCsrfToken(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    return req.session.csrfToken;
}

function csrfProtect(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return next();
    }
    const token = req.body._csrf || req.headers['x-csrf-token'];
    if (!token || token !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next();
}

// Expose CSRF token to all views via res.locals
app.use((req, res, next) => {
    res.locals.csrfToken = generateCsrfToken(req);
    next();
});


const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    return res.redirect('/login');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
}

function getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
        try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    return result;
}

// Write helper — uses the shared writable connection.
function writeSetting(key, value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    dbWrite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, serialized);
}

function normalizeTimeframe(tf) {
    return ['24h', '7d', '30d', '90d', 'all'].includes(tf) ? tf : 'all';
}

// ── Discord REST helpers ────────────────────────────────────────────────────────

function discordGet(apiPath) {
    return new Promise((resolve, reject) => {
        const token = process.env.DISCORD_TOKEN;
        if (!token) return reject(new Error('DISCORD_TOKEN not set'));
        const options = {
            hostname: 'discord.com',
            path: `/api/v10${apiPath}`,
            method: 'GET',
            headers: {
                'Authorization': `Bot ${token}`,
                'User-Agent': 'VotingDashboard/1.0',
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (parseErr) {
                    console.error('Discord API parse error:', parseErr.message, '| path:', apiPath, '| raw:', data.slice(0, 200));
                    resolve(null);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

let cachedGuildId = null;
async function getGuildId() {
    if (cachedGuildId) return cachedGuildId;
    if (process.env.GUILD_ID) {
        cachedGuildId = process.env.GUILD_ID;
        return cachedGuildId;
    }
    const channelId = process.env.MAIN_CHANNEL_ID;
    if (!channelId) return null;
    const channel = await discordGet(`/channels/${channelId}`);
    if (channel && channel.guild_id) {
        cachedGuildId = channel.guild_id;
        return cachedGuildId;
    }
    return null;
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Login
app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) return res.redirect('/');
    res.render('login', { error: null });
});

app.post('/login', loginLimiter, csrfProtect, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.render('login', { error: 'Password is required.' });

    const hash = getSetting('dashboard_password_hash');
    if (!hash) {
        return res.render('login', { error: 'Dashboard password is not configured. Set DASHBOARD_PASSWORD in .env.' });
    }

    const match = await bcrypt.compare(String(password), String(hash));
    if (!match) return res.render('login', { error: 'Incorrect password.' });

    req.session.authenticated = true;
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// Root redirect
app.get('/', requireAuth, (req, res) => res.redirect('/leaderboard'));

// Leaderboard page
app.get('/leaderboard', requireAuth, (req, res) => {
    const timeframe = normalizeTimeframe(req.query.timeframe);
    const { startMs, endMs } = getTimeRange(timeframe);

    const topVoted = getTopVotedUsers(db, startMs, endMs, 50);
    const topVoters = getTopVoters(db, startMs, endMs, 50);
    const stats = getStats(db, startMs, endMs);

    res.render('leaderboard', { topVoted, topVoters, stats, timeframe });
});

// Posts page
app.get('/posts', requireAuth, (req, res) => {
    const timeframe = normalizeTimeframe(req.query.timeframe);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 20;
    const { startMs, endMs } = getTimeRange(timeframe);

    const posts = getPosts(db, startMs, endMs, page, pageSize);
    const totalCount = getPostsCount(db, startMs, endMs);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    res.render('posts', { posts, page, totalPages, timeframe });
});

// Settings page
app.get('/settings', requireAuth, (req, res) => {
    const settings = getAllSettings();
    // Never send the password hash to the view
    delete settings.dashboard_password_hash;
    res.render('settings', { settings, saved: req.query.saved === '1', error: null });
});

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api', apiLimiter, csrfProtect);

const VOTE_EMOJI_COUNT = 5;

// Save settings
app.post('/api/settings', requireAuth, (req, res) => {
    try {
        const { tracked_forum_id, tracked_roles, multi_vote_mode, vote_emojis, vote_emoji_weights } = req.body;

        if (tracked_forum_id !== undefined) {
            writeSetting('tracked_forum_id', String(tracked_forum_id).trim());
        }

        if (tracked_roles !== undefined) {
            let roles;
            if (typeof tracked_roles === 'string') {
                try { roles = JSON.parse(tracked_roles); } catch { roles = []; }
            } else {
                roles = tracked_roles;
            }
            if (!Array.isArray(roles)) roles = [];
            roles = roles.map(r => {
                const weight = (typeof r.weight === 'number' && isFinite(r.weight) && r.weight >= 0) ? r.weight : 1;
                return { id: String(r.id || ''), name: String(r.name || ''), position: parseInt(r.position) || 0, weight };
            }).filter(r => r.id);
            writeSetting('tracked_roles', roles);
        }

        if (multi_vote_mode !== undefined) {
            const allowed = ['highest', 'lowest', 'average', 'ignore'];
            if (!allowed.includes(multi_vote_mode)) {
                return res.status(400).json({ error: 'Invalid multi_vote_mode' });
            }
            writeSetting('multi_vote_mode', multi_vote_mode);
        }

        if (vote_emojis !== undefined) {
            let emojis;
            if (typeof vote_emojis === 'string') {
                try { emojis = JSON.parse(vote_emojis); } catch { emojis = []; }
            } else {
                emojis = vote_emojis;
            }
            if (!Array.isArray(emojis) || emojis.length !== VOTE_EMOJI_COUNT) {
                return res.status(400).json({ error: 'vote_emojis must be an array of exactly 5 emojis' });
            }
            writeSetting('vote_emojis', emojis);
        }

        if (vote_emoji_weights !== undefined) {
            let weights;
            if (typeof vote_emoji_weights === 'string') {
                try { weights = JSON.parse(vote_emoji_weights); } catch { weights = []; }
            } else {
                weights = vote_emoji_weights;
            }
            if (!Array.isArray(weights) || weights.length !== VOTE_EMOJI_COUNT ||
                !weights.every(w => typeof w === 'number' && isFinite(w) && w >= 0)) {
                return res.status(400).json({ error: 'vote_emoji_weights must be an array of exactly 5 non-negative numbers' });
            }
            writeSetting('vote_emoji_weights', weights);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('Error saving settings:', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Change password
app.post('/api/settings/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'currentPassword and newPassword are required' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const hash = getSetting('dashboard_password_hash');
        if (!hash) {
            return res.status(400).json({ error: 'No password is set. Configure DASHBOARD_PASSWORD in .env first.' });
        }

        const match = await bcrypt.compare(String(currentPassword), String(hash));
        if (!match) return res.status(403).json({ error: 'Current password is incorrect' });

        const newHash = await bcrypt.hash(String(newPassword), 12);
        writeSetting('dashboard_password_hash', newHash);

        res.json({ ok: true });
    } catch (err) {
        console.error('Error changing password:', err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// JSON leaderboard (AJAX)
app.get('/api/leaderboard', requireAuth, (req, res) => {
    const timeframe = normalizeTimeframe(req.query.timeframe);
    const { startMs, endMs } = getTimeRange(timeframe);

    const topVoted = getTopVotedUsers(db, startMs, endMs, 50);
    const topVoters = getTopVoters(db, startMs, endMs, 50);
    const stats = getStats(db, startMs, endMs);

    res.json({ topVoted, topVoters, stats, timeframe });
});

// Discord roles
app.get('/api/discord/roles', requireAuth, async (req, res) => {
    try {
        const guildId = await getGuildId();
        if (!guildId) return res.json({ roles: [] });
        const data = await discordGet(`/guilds/${guildId}/roles`);
        if (!Array.isArray(data)) return res.json({ roles: [] });
        const roles = data
            .map(r => ({ id: r.id, name: r.name, position: r.position, color: r.color }))
            .sort((a, b) => b.position - a.position);
        res.json({ roles });
    } catch (err) {
        console.error('Error fetching Discord roles:', err);
        res.json({ roles: [] });
    }
});

// Discord channels
app.get('/api/discord/channels', requireAuth, async (req, res) => {
    try {
        const guildId = await getGuildId();
        if (!guildId) return res.json({ channels: [] });
        const data = await discordGet(`/guilds/${guildId}/channels`);
        if (!Array.isArray(data)) return res.json({ channels: [] });
        const channels = data
            .map(c => ({ id: c.id, name: c.name, type: c.type, position: c.position }))
            .sort((a, b) => (a.position || 0) - (b.position || 0));
        res.json({ channels });
    } catch (err) {
        console.error('Error fetching Discord channels:', err);
        res.json({ channels: [] });
    }
});

// Discord threads
app.get('/api/discord/threads', requireAuth, async (req, res) => {
    const { channelId } = req.query;
    if (!channelId || !/^\d+$/.test(String(channelId))) {
        return res.json({ threads: [] });
    }
    try {
        const [active, archived] = await Promise.allSettled([
            discordGet(`/channels/${channelId}/threads/active`),
            discordGet(`/channels/${channelId}/threads/archived/public`),
        ]);
        const threads = [];
        if (active.status === 'fulfilled' && active.value && Array.isArray(active.value.threads)) {
            threads.push(...active.value.threads);
        }
        if (archived.status === 'fulfilled' && archived.value && Array.isArray(archived.value.threads)) {
            threads.push(...archived.value.threads);
        }
        const result = threads
            .map(t => ({ id: t.id, name: t.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ threads: result });
    } catch (err) {
        console.error('Error fetching Discord threads:', err);
        res.json({ threads: [] });
    }
});

// ── Start server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Dashboard] Listening on http://localhost:${PORT}`);
});

module.exports = app; // for testing
