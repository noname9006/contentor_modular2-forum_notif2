'use strict';

const { getSetting } = require('./db');
const { getHighestTrackedRole } = require('./roleHelper');
const { loadCacheFromDb, getUserInfo } = require('./userCache');
const { logWithTimestamp } = require('../utils');

const REACTION_DELAY_MS = 300;

class VoteHandler {
    /**
     * @param {import('discord.js').Client} client
     * @param {import('better-sqlite3').Database} db
     */
    constructor(client, db) {
        this.client = client;
        this.db = db;
        this.trackedForumId = null;
        this.voteEmojis = [];
        // Map of emoji string -> vote value (0-4)
        this.emojiToValue = new Map();
    }

    /**
     * Load settings from DB. Must be called after initDb().
     */
    async init() {
        this._reloadSettings();
        loadCacheFromDb(this.db);

        if (!this.trackedForumId) {
            logWithTimestamp(
                'Vote handler: tracked_forum_id is not configured. Voting will be inactive until set via dashboard.',
                'WARN'
            );
        } else {
            logWithTimestamp(`Vote handler: tracking forum channel ${this.trackedForumId}`, 'CONFIG');
        }
    }

    _reloadSettings() {
        this.trackedForumId = getSetting('tracked_forum_id') || null;
        const emojis = getSetting('vote_emojis');
        this.voteEmojis = Array.isArray(emojis) ? emojis : ['🧊', '🌤️', '⚡', '🔥', '💥'];
        this.emojiToValue = new Map();
        this.voteEmojis.forEach((emoji, idx) => {
            this.emojiToValue.set(emoji, idx);
        });
    }

    /**
     * Register all Discord event listeners.
     */
    registerEvents() {
        this.client.on('messageCreate', (msg) => this._onMessageCreate(msg).catch(err =>
            logWithTimestamp(`VoteHandler messageCreate error: ${err.message}`, 'ERROR')
        ));

        this.client.on('messageReactionAdd', (reaction, user) =>
            this._onReactionAdd(reaction, user).catch(err =>
                logWithTimestamp(`VoteHandler reactionAdd error: ${err.message}`, 'ERROR')
            )
        );

        this.client.on('messageReactionRemove', (reaction, user) =>
            this._onReactionRemove(reaction, user).catch(err =>
                logWithTimestamp(`VoteHandler reactionRemove error: ${err.message}`, 'ERROR')
            )
        );

        this.client.on('messageDelete', (msg) =>
            this._onMessageDelete(msg).catch(err =>
                logWithTimestamp(`VoteHandler messageDelete error: ${err.message}`, 'ERROR')
            )
        );
    }

    shutdown() {
        // No persistent connections to close — better-sqlite3 is managed by db.js
        logWithTimestamp('VoteHandler shutdown complete', 'SHUTDOWN');
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Check whether a thread belongs to the tracked forum channel.
     * Re-reads trackedForumId from DB so settings changes take effect without restart.
     */
    async _isTrackedThread(channel) {
        this._reloadSettings();
        if (!this.trackedForumId) return false;
        if (!channel.isThread()) return false;
        const parent = await channel.parent?.fetch().catch(() => null);
        return parent?.id === this.trackedForumId;
    }

    _getPost(messageId) {
        return this.db.prepare('SELECT * FROM posts WHERE message_id = ?').get(messageId);
    }

    _upsertPost(data) {
        this.db.prepare(`
            INSERT OR IGNORE INTO posts
              (message_id, thread_id, forum_channel_id, guild_id, author_id, author_name, highest_role_id, content, posted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.messageId,
            data.threadId,
            data.forumChannelId,
            data.guildId,
            data.authorId,
            data.authorName,
            data.highestRoleId || null,
            data.content || null,
            data.postedAt
        );
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    async _onMessageCreate(message) {
        if (message.author.bot) return;
        if (!message.guild) return;

        if (!(await this._isTrackedThread(message.channel))) return;

        const trackedRoles = getSetting('tracked_roles') || [];
        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        const highestRole = member ? getHighestTrackedRole(member, trackedRoles) : null;

        // Record the post
        this._upsertPost({
            messageId: message.id,
            threadId: message.channel.id,
            forumChannelId: message.channel.parentId,
            guildId: message.guild.id,
            authorId: message.author.id,
            authorName: message.author.username,
            highestRoleId: highestRole ? highestRole.id : null,
            content: message.content || null,
            postedAt: message.createdTimestamp,
        });

        // Cache author info (best-effort, non-critical)
        getUserInfo(message.author.id, this.client).catch(err =>
            logWithTimestamp(`User cache update failed for ${message.author.id}: ${err.message}`, 'WARN')
        );

        // Add reactions sequentially with delay
        for (let i = 0; i < this.voteEmojis.length; i++) {
            const emoji = this.voteEmojis[i];
            try {
                await message.react(emoji);
            } catch (err) {
                logWithTimestamp(`Failed to react with ${emoji} on ${message.id}: ${err.message}`, 'WARN');
            }
            if (i < this.voteEmojis.length - 1) {
                await new Promise(resolve => setTimeout(resolve, REACTION_DELAY_MS));
            }
        }
    }

    async _onReactionAdd(reaction, user) {
        if (user.bot) return;

        // Resolve partials
        if (reaction.partial) {
            try { reaction = await reaction.fetch(); } catch (err) {
                logWithTimestamp(`Failed to fetch partial reaction: ${err.message}`, 'WARN');
                return;
            }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch (err) {
                logWithTimestamp(`Failed to fetch partial message: ${err.message}`, 'WARN');
                return;
            }
        }

        const emoji = reaction.emoji.name;
        if (!this.emojiToValue.has(emoji)) return;

        const message = reaction.message;
        if (!message.guild) return;

        if (!(await this._isTrackedThread(message.channel))) return;

        // No self-voting
        if (user.id === message.author.id) return;

        const voteValue = this.emojiToValue.get(emoji);

        // If post not in DB, try to backfill it
        let post = this._getPost(message.id);
        if (!post) {
            const trackedRoles = getSetting('tracked_roles') || [];
            const authorMember = await message.guild.members.fetch(message.author.id).catch(() => null);
            const highestRole = authorMember ? getHighestTrackedRole(authorMember, trackedRoles) : null;

            this._upsertPost({
                messageId: message.id,
                threadId: message.channel.id,
                forumChannelId: message.channel.parentId,
                guildId: message.guild.id,
                authorId: message.author.id,
                authorName: message.author.username,
                highestRoleId: highestRole ? highestRole.id : null,
                content: message.content || null,
                postedAt: message.createdTimestamp,
            });
            post = this._getPost(message.id);
        }

        if (!post) {
            logWithTimestamp(`Could not backfill post ${message.id}, skipping vote`, 'WARN');
            return;
        }

        // Resolve voter's highest tracked role
        const trackedRoles = getSetting('tracked_roles') || [];
        const voterMember = await message.guild.members.fetch(user.id).catch(() => null);
        const voterRole = voterMember ? getHighestTrackedRole(voterMember, trackedRoles) : null;

        try {
            this.db.prepare(`
                INSERT OR IGNORE INTO votes (message_id, author_id, voter_id, voter_role_id, vote_value, voted_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                message.id,
                message.author.id,
                user.id,
                voterRole ? voterRole.id : null,
                voteValue,
                Date.now()
            );
        } catch (err) {
            logWithTimestamp(`Failed to insert vote: ${err.message}`, 'ERROR');
        }

        // Cache voter info (best-effort, non-critical)
        getUserInfo(user.id, this.client).catch(err =>
            logWithTimestamp(`User cache update failed for ${user.id}: ${err.message}`, 'WARN')
        );
    }

    async _onReactionRemove(reaction, user) {
        if (user.bot) return;

        if (reaction.partial) {
            try { reaction = await reaction.fetch(); } catch (err) {
                logWithTimestamp(`Failed to fetch partial reaction (remove): ${err.message}`, 'WARN');
                return;
            }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch (err) {
                logWithTimestamp(`Failed to fetch partial message (remove): ${err.message}`, 'WARN');
                return;
            }
        }

        const emoji = reaction.emoji.name;
        if (!this.emojiToValue.has(emoji)) return;

        const voteValue = this.emojiToValue.get(emoji);
        const messageId = reaction.message.id;

        try {
            this.db.prepare(
                'DELETE FROM votes WHERE message_id = ? AND voter_id = ? AND vote_value = ?'
            ).run(messageId, user.id, voteValue);
        } catch (err) {
            logWithTimestamp(`Failed to delete vote: ${err.message}`, 'ERROR');
        }
    }

    async _onMessageDelete(message) {
        const now = Date.now();
        try {
            this.db.prepare(
                'UPDATE posts SET deleted = 1, deleted_at = ? WHERE message_id = ?'
            ).run(now, message.id);
        } catch (err) {
            logWithTimestamp(`Failed to mark post ${message.id} as deleted: ${err.message}`, 'ERROR');
        }
    }
}

module.exports = VoteHandler;
