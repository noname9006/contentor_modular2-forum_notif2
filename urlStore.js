const fs = require('fs/promises');
const path = require('path');
const { logWithTimestamp } = require('./utils');

class UrlStorage {
    constructor() {
        this.urls = new Map();
        this.storageFile = path.join(__dirname, 'data', 'urls.json');
        this.isInitialized = false;
    }

    async init() {
        try {
            await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
            const data = await fs.readFile(this.storageFile, 'utf8').catch(() => '{}');
            const urlData = JSON.parse(data);
            
            for (const [channelId, urls] of Object.entries(urlData)) {
                this.urls.set(channelId, urls);
            }
            
            this.isInitialized = true;
            logWithTimestamp('URL storage initialized', 'STARTUP');
        } catch (error) {
            logWithTimestamp(`Error initializing URL storage: ${error.message}`, 'ERROR');
            this.urls = new Map();
            this.isInitialized = false;
        }
    }

    async saveUrls(channelId, newUrls) {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return;
        }

        try {
            const existingUrls = this.urls.get(channelId) || [];
            const updatedUrls = [...existingUrls];

            newUrls.forEach(newUrl => {
                if (!updatedUrls.some(existing => existing.url === newUrl.url)) {
                    updatedUrls.push(newUrl);
                }
            });

            updatedUrls.sort((a, b) => b.timestamp - a.timestamp);
            this.urls.set(channelId, updatedUrls);
            
            const urlData = Object.fromEntries(this.urls);
            await fs.writeFile(this.storageFile, JSON.stringify(urlData, null, 2));
            
            logWithTimestamp(`Saved ${newUrls.length} URLs for channel ${channelId}`, 'INFO');
            return updatedUrls.length;
        } catch (error) {
            logWithTimestamp(`Error saving URLs: ${error.message}`, 'ERROR');
            return 0;
        }
    }

    // Add the missing findUrlHistory method
    async findUrlHistory(url) {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return null;
        }

        for (const [channelId, urls] of this.urls.entries()) {
            const foundUrl = urls.find(entry => entry.url === url);
            if (foundUrl) {
                logWithTimestamp(`URL history found for: ${url}`, 'INFO');
                return foundUrl;
            }
        }

        logWithTimestamp(`No URL history found for: ${url}`, 'INFO');
        return null;
    }

    // Add the missing addUrl method
    async addUrl(url, userId, channelId, threadId = null, messageId, author = 'Unknown') {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return null;
        }

        const urlEntry = {
            url,
            userId,
            channelId,
            threadId,
            messageId,
            author,
            timestamp: Date.now()
        };

        const existingUrls = this.urls.get(channelId) || [];
        existingUrls.push(urlEntry);
        await this.saveUrls(channelId, existingUrls);

        logWithTimestamp(`Added URL: ${url} by ${author}`, 'INFO');
        return urlEntry;
    }

    getUrls(channelId) {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return [];
        }
        return this.urls.get(channelId) || [];
    }

    async cleanup() {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return;
        }

        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        const now = Date.now();
        let totalRemoved = 0;

        for (const [channelId, urls] of this.urls.entries()) {
            const originalLength = urls.length;
            const filteredUrls = urls.filter(url => now - url.timestamp < maxAge);
            if (filteredUrls.length !== originalLength) {
                this.urls.set(channelId, filteredUrls);
                totalRemoved += originalLength - filteredUrls.length;
            }
        }

        if (totalRemoved > 0) {
            try {
                const urlData = Object.fromEntries(this.urls);
                await fs.writeFile(this.storageFile, JSON.stringify(urlData, null, 2));
                logWithTimestamp(`Cleaned up ${totalRemoved} old URLs`, 'INFO');
            } catch (error) {
                logWithTimestamp(`Error during URL cleanup: ${error.message}`, 'ERROR');
            }
        }
    }

    async getAllChannelIds() {
        return Array.from(this.urls.keys());
    }

    async getStats() {
        const stats = {
            totalUrls: 0,
            channelCount: this.urls.size,
            urlsPerChannel: {}
        };

        for (const [channelId, urls] of this.urls.entries()) {
            stats.totalUrls += urls.length;
            stats.urlsPerChannel[channelId] = urls.length;
        }

        return stats;
    }

    shutdown() {
        logWithTimestamp('URL storage shutting down', 'SHUTDOWN');
    }
}

module.exports = UrlStorage; // Keep the original export name