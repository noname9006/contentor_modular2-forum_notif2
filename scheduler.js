const cron = require('node-cron');
const { logWithTimestamp } = require('./utils');
const { ROLE_TO_THREAD_ENABLED, THREAD_INACTIVITY_DAYS, THREAD_USERS_THRESHOLD, THREAD_USERS_THRESHOLD_REMOVE } = require('./config');

const MAX_HISTORY_MESSAGES = 10000;
const HISTORY_FETCH_BATCH = 100;
const HISTORY_FETCH_DELAY_MS = 250;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Cleanup-specific ignored roles (separate from IGNORED_ROLES used for routing)
const ignoredRolesCleanup = new Set(
    process.env.IGNORED_ROLES_CLEANUP
        ? process.env.IGNORED_ROLES_CLEANUP.split(',').map(r => r.trim()).filter(Boolean)
        : []
);

class ThreadCleaner {
    constructor(client, activityStore) {
        this.client = client;
        this.activityStore = activityStore;
        this.schedule = null;
        this.isRunning = false;
    }

    init(cronExpression) {
        if (!cronExpression || typeof cronExpression !== 'string') {
            logWithTimestamp('Invalid cron expression for thread cleaning schedule', 'ERROR');
            return false;
        }

        try {
            if (!cron.validate(cronExpression)) {
                throw new Error('Invalid cron expression format');
            }

            this.schedule = cron.schedule(cronExpression, () => {
                this.performCleanup()
                    .catch(err => logWithTimestamp(`Error during scheduled thread cleanup: ${err.message}`, 'ERROR'));
            });

            logWithTimestamp(`Thread cleaner initialized with schedule: ${cronExpression}`, 'STARTUP');
            return true;
        } catch (error) {
            logWithTimestamp(`Failed to initialize thread cleaner: ${error.message}`, 'ERROR');
            return false;
        }
    }

    getThreadAndRoleMappings() {
        const threadIds = [];
        const roleToThread = new Map();
        const threadToRole = new Map();
        const ignoredRoles = new Set(
            process.env.IGNORED_ROLES
                ? process.env.IGNORED_ROLES.split(',').map(r => r.trim()).filter(Boolean)
                : []
        );

        for (let i = 0; i <= 5; i++) {
            const roleId = process.env[`ROLE_${i}_ID`];
            const threadId = process.env[`THREAD_${i}_ID`];

            if (roleId && threadId) {
                threadIds.push(threadId);
                roleToThread.set(roleId, threadId);
                threadToRole.set(threadId, roleId);
            }
        }

        return { threadIds, roleToThread, threadToRole, ignoredRoles };
    }

    findHighestRole(memberRoles) {
        for (let i = 5; i >= 0; i--) {
            const roleId = process.env[`ROLE_${i}_ID`];
            if (memberRoles.has(roleId)) {
                return i;
            }
        }
        return -1;
    }

    memberHasCorrectRoleForThread(member, threadId, threadToRole, ignoredRoles) {
        if (member.roles.cache.some(role => ignoredRoles.has(role.id))) {
            return true;
        }

        const highestRoleIndex = this.findHighestRole(member.roles.cache);
        if (highestRoleIndex === -1) {
            return false;
        }

        const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
        return threadId === correctThreadId;
    }

    async findLastMessageTimestamp(thread, userId) {
        let lastId = null;
        let fetched = 0;

        while (fetched < MAX_HISTORY_MESSAGES) {
            const options = { limit: Math.min(HISTORY_FETCH_BATCH, MAX_HISTORY_MESSAGES - fetched) };
            if (lastId) options.before = lastId;

            let messages;
            try {
                messages = await thread.messages.fetch(options);
            } catch (err) {
                logWithTimestamp(`Error fetching messages for history scan in ${thread.id}: ${err.message}`, 'ERROR');
                break;
            }

            if (messages.size === 0) break;

            // Look for the user's message — messages are newest-first
            for (const [, msg] of messages) {
                if (msg.author.id === userId) {
                    return msg.createdTimestamp;
                }
            }

            lastId = messages.last().id;
            fetched += messages.size;

            if (messages.size < HISTORY_FETCH_BATCH) break;

            // Small delay to avoid hitting rate limits
            await new Promise(resolve => setTimeout(resolve, HISTORY_FETCH_DELAY_MS));
        }

        return null;
    }

    async cleanThread(thread, roleMode) {
        const { threadToRole, ignoredRoles } = this.getThreadAndRoleMappings();
        const threadId = thread.id;

        const threadMembers = await thread.members.fetch();
        logWithTimestamp(`Checking ${threadMembers.size} members in thread ${thread.name} (${threadId})`, 'INFO');

        if (roleMode && THREAD_USERS_THRESHOLD > 0) {
            const eligibleMemberCount = threadMembers.size - (threadMembers.has(this.client.user.id) ? 1 : 0);
            if (eligibleMemberCount < THREAD_USERS_THRESHOLD) {
                logWithTimestamp(`Thread ${thread.name}: ${eligibleMemberCount} members below threshold ${THREAD_USERS_THRESHOLD}, skipping role-mismatch cleanup`, 'INFO');
                return 0;
            }
        }

        let removedFromThread = 0;

        for (const [memberId] of threadMembers) {
            if (memberId === this.client.user.id) continue;

            try {
                const guildMember = await thread.guild.members.fetch(memberId).catch(() => null);

                if (roleMode) {
                    // Role-based cleanup
                    const shouldRemove = !guildMember ||
                        !this.memberHasCorrectRoleForThread(guildMember, threadId, threadToRole, ignoredRoles);

                    if (shouldRemove) {
                        await thread.members.remove(memberId);
                        removedFromThread++;
                        const reason = !guildMember ? 'left server' : 'incorrect role';
                        logWithTimestamp(`Removed member ${memberId} from thread ${thread.name}: ${reason}`, 'INFO');
                    }
                } else {
                    // Time-based cleanup
                    // Members who left the server are removed
                    if (!guildMember) {
                        await thread.members.remove(memberId);
                        removedFromThread++;
                        logWithTimestamp(`Removed member ${memberId} from thread ${thread.name}: left server`, 'INFO');
                        continue;
                    }

                    // Skip members with cleanup-exempt roles
                    if (guildMember.roles.cache.some(role => ignoredRolesCleanup.has(role.id))) {
                        continue;
                    }

                    const thresholdMs = THREAD_INACTIVITY_DAYS * MS_PER_DAY;
                    const now = Date.now();

                    let lastActivity = this.activityStore.getLastActivity(threadId, memberId);

                    if (lastActivity === null) {
                        // No record — scan message history to seed
                        const historyTs = await this.findLastMessageTimestamp(thread, memberId);
                        if (historyTs !== null) {
                            await this.activityStore.updateActivity(threadId, memberId, historyTs);
                            lastActivity = historyTs;
                            logWithTimestamp(`Seeded activity for member ${memberId} in thread ${thread.name}: ${new Date(historyTs).toISOString()}`, 'INFO');
                        }
                    }

                    if (lastActivity === null) {
                        // User never posted — remove
                        await thread.members.remove(memberId);
                        removedFromThread++;
                        logWithTimestamp(`Removed member ${memberId} from thread ${thread.name}: never posted`, 'INFO');
                    } else if (now - lastActivity > thresholdMs) {
                        // Inactive beyond threshold — remove
                        await thread.members.remove(memberId);
                        removedFromThread++;
                        const daysAgo = Math.floor((now - lastActivity) / MS_PER_DAY);
                        logWithTimestamp(`Removed member ${memberId} from thread ${thread.name}: inactive for ${daysAgo} days`, 'INFO');
                    }
                }
            } catch (memberError) {
                logWithTimestamp(`Error processing member ${memberId} in thread ${thread.name}: ${memberError.message}`, 'ERROR');
            }
        }

        logWithTimestamp(`Thread ${thread.name}: Removed ${removedFromThread} of ${threadMembers.size} members`, 'INFO');
        return removedFromThread;
    }

    async applyThresholdCleanup(thread) {
        const threadId = thread.id;
        const threadMembers = await thread.members.fetch();

        // Exclude the bot itself
        const eligibleMembers = [...threadMembers.values()].filter(m => m.id !== this.client.user.id);

        if (eligibleMembers.length < THREAD_USERS_THRESHOLD) {
            logWithTimestamp(`Thread ${thread.name}: member count ${eligibleMembers.length} below threshold ${THREAD_USERS_THRESHOLD}, skipping`, 'INFO');
            return 0;
        }

        // Build list with last activity timestamps, filtering out ignored roles
        const membersWithActivity = [];
        for (const member of eligibleMembers) {
            const guildMember = await thread.guild.members.fetch(member.id).catch(() => null);

            // Skip members with cleanup-exempt roles (if we can fetch them)
            if (guildMember && guildMember.roles.cache.some(role => ignoredRolesCleanup.has(role.id))) {
                continue;
            }

            const lastActivity = this.activityStore.getLastActivity(threadId, member.id) ?? 0;
            membersWithActivity.push({ id: member.id, lastActivity });
        }

        // Sort ascending: least recently active first (0 = never active, sorts first)
        membersWithActivity.sort((a, b) => a.lastActivity - b.lastActivity);

        const toRemove = membersWithActivity.slice(0, THREAD_USERS_THRESHOLD_REMOVE);
        let removedCount = 0;

        for (const { id } of toRemove) {
            try {
                await thread.members.remove(id);
                removedCount++;
                logWithTimestamp(`Removed member ${id} from thread ${thread.name}: threshold exceeded (least active)`, 'INFO');
            } catch (err) {
                logWithTimestamp(`Error removing member ${id} from thread ${thread.name} during threshold cleanup: ${err.message}`, 'ERROR');
            }
        }

        return removedCount;
    }

    async performCleanup() {
        if (this.isRunning) {
            logWithTimestamp('Thread cleanup is already in progress, skipping', 'WARN');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();
        logWithTimestamp('Starting scheduled thread cleanup', 'INFO');

        try {
            let threadIds;

            if (ROLE_TO_THREAD_ENABLED) {
                const mappings = this.getThreadAndRoleMappings();
                threadIds = mappings.threadIds;

                if (threadIds.length === 0) {
                    logWithTimestamp('No threads configured for cleanup', 'WARN');
                    return;
                }
            } else {
                // Time-based: clean all threads under MAIN_CHANNEL_ID
                const mainChannelId = process.env.MAIN_CHANNEL_ID;
                const mainChannel = await this.client.channels.fetch(mainChannelId).catch(() => null);
                if (!mainChannel) {
                    logWithTimestamp(`Main channel ${mainChannelId} not found`, 'ERROR');
                    return;
                }
                const fetchedThreads = await mainChannel.threads.fetch();
                threadIds = Array.from(fetchedThreads.threads.keys());

                if (threadIds.length === 0) {
                    logWithTimestamp('No active threads found under main channel', 'WARN');
                    return;
                }
            }

            let totalChecked = 0;
            let totalRemoved = 0;
            let failedThreads = 0;

            for (const threadId of threadIds) {
                try {
                    const thread = await this.client.channels.fetch(threadId);

                    if (!thread) {
                        logWithTimestamp(`Thread ${threadId} not found`, 'ERROR');
                        failedThreads++;
                        continue;
                    }

                    if (!thread.isThread()) {
                        logWithTimestamp(`Channel ${threadId} (${thread.name}) is not a thread, skipping`, 'WARN');
                        continue;
                    }

                    const removed = await this.cleanThread(thread, ROLE_TO_THREAD_ENABLED);
                    totalRemoved += removed;

                    if (THREAD_USERS_THRESHOLD > 0) {
                        const thresholdRemoved = await this.applyThresholdCleanup(thread);
                        totalRemoved += thresholdRemoved;
                    }

                    totalChecked++;
                } catch (threadError) {
                    logWithTimestamp(`Error processing thread ${threadId}: ${threadError.message}`, 'ERROR');
                    failedThreads++;
                }
            }

            const duration = (Date.now() - startTime) / 1000;
            logWithTimestamp(`Thread cleanup completed in ${duration.toFixed(2)}s: Checked ${totalChecked} threads, removed ${totalRemoved} members, failed threads: ${failedThreads}`, 'INFO');
        } catch (error) {
            logWithTimestamp(`Thread cleanup failed: ${error.message}`, 'ERROR');
        } finally {
            this.isRunning = false;
        }
    }

    async cleanSpecificThread(threadId) {
        if (this.isRunning) {
            logWithTimestamp('Thread cleanup is already in progress, skipping', 'WARN');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();
        logWithTimestamp(`Starting thread cleanup for specific thread: ${threadId}`, 'INFO');

        try {
            if (ROLE_TO_THREAD_ENABLED) {
                const { threadToRole } = this.getThreadAndRoleMappings();
                if (!threadToRole.has(threadId)) {
                    logWithTimestamp(`Thread ${threadId} not configured for cleanup`, 'WARN');
                    return;
                }
            }

            const thread = await this.client.channels.fetch(threadId);

            if (!thread) {
                logWithTimestamp(`Thread ${threadId} not found`, 'ERROR');
                return;
            }

            if (!thread.isThread()) {
                logWithTimestamp(`Channel ${threadId} (${thread.name}) is not a thread, skipping`, 'WARN');
                return;
            }

            const removed = await this.cleanThread(thread, ROLE_TO_THREAD_ENABLED);

            let totalRemoved = removed;
            if (THREAD_USERS_THRESHOLD > 0) {
                totalRemoved += await this.applyThresholdCleanup(thread);
            }

            const duration = (Date.now() - startTime) / 1000;
            logWithTimestamp(`Thread cleanup completed in ${duration.toFixed(2)}s: Removed ${totalRemoved} members from ${thread.name}`, 'INFO');
        } catch (error) {
            logWithTimestamp(`Thread cleanup failed: ${error.message}`, 'ERROR');
        } finally {
            this.isRunning = false;
        }
    }

    stop() {
        if (this.schedule) {
            this.schedule.stop();
            logWithTimestamp('Thread cleaner schedule stopped', 'INFO');
        }
    }
}

module.exports = ThreadCleaner;
