const fs = require('fs/promises');
const path = require('path');
const { logWithTimestamp } = require('./utils');

class ActivityStore {
    constructor() {
        this.activity = {};
        this.storageFile = '';
        this.isInitialized = false;
    }

    async init() {
        try {
            const mainChannelId = process.env.MAIN_CHANNEL_ID;
            if (!mainChannelId) {
                throw new Error('MAIN_CHANNEL_ID environment variable is not set');
            }

            this.storageFile = path.join(__dirname, `ACTIVITY_DB_${mainChannelId}.json`);

            const data = await fs.readFile(this.storageFile, 'utf8').catch(() => '{}');
            this.activity = JSON.parse(data);

            this.isInitialized = true;
            logWithTimestamp('Activity storage initialized', 'STARTUP');
        } catch (error) {
            logWithTimestamp(`Error initializing activity storage: ${error.message}`, 'ERROR');
            this.activity = {};
            this.isInitialized = false;
            throw error;
        }
    }

    async save() {
        try {
            await fs.writeFile(this.storageFile, JSON.stringify(this.activity, null, 2));
        } catch (error) {
            logWithTimestamp(`Error saving activity storage: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async updateActivity(threadId, userId, timestamp) {
        if (!this.isInitialized) {
            logWithTimestamp('Activity storage not initialized', 'ERROR');
            return;
        }

        if (!this.activity[threadId]) {
            this.activity[threadId] = {};
        }

        this.activity[threadId][userId] = timestamp;
        await this.save();
    }

    getLastActivity(threadId, userId) {
        if (!this.isInitialized) {
            logWithTimestamp('Activity storage not initialized', 'ERROR');
            return null;
        }

        const threadActivity = this.activity[threadId];
        if (!threadActivity) return null;

        const ts = threadActivity[userId];
        return ts !== undefined ? ts : null;
    }

    getAllActivity(threadId) {
        if (!this.isInitialized) {
            logWithTimestamp('Activity storage not initialized', 'ERROR');
            return {};
        }

        return this.activity[threadId] || {};
    }

    shutdown() {
        logWithTimestamp('Activity Storage shutting down...', 'SHUTDOWN');
        this.isInitialized = false;
    }
}

module.exports = ActivityStore;
