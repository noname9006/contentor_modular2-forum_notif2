const { EmbedBuilder, ChannelType } = require('discord.js');
const UrlStore = require('./urlStore');
const { logWithTimestamp } = require('./utils');
const { DB_TIMEOUT } = require('./config');

class UrlTracker {
    constructor(client) {
        this.client = client;
        this.urlStore = new UrlStore();
        this.urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
    }

    async init() {
        try {
            await this.urlStore.init();
            logWithTimestamp('URL Tracker initialized successfully', 'INFO');
        } catch (error) {
            logWithTimestamp(`Failed to initialize URL Tracker: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async fetchAllUrlsFromChannel(channelId) {
        const channel = await this.client.channels.fetch(channelId).catch(error => {
            logWithTimestamp(`Failed to fetch channel: ${error.message}`, 'ERROR');
            return null;
        });

        if (!channel) {
            logWithTimestamp(`Channel not found: ${channelId}`, 'ERROR');
            return [];
        }

        let urls = [];

        try {
            if (channel.type === ChannelType.GuildForum) {
                logWithTimestamp(`Fetching threads from forum channel: ${channelId}`, 'INFO');
                const threads = await channel.threads.fetch();
                
                for (const [threadId, thread] of threads.threads) {
                    logWithTimestamp(`Fetching messages from thread: ${threadId}`, 'INFO');
                    const messages = await thread.messages.fetch({ limit: 100 });
                    
                    messages.forEach(message => {
                        const foundUrls = message.content.match(this.urlRegex);
                        if (foundUrls) {
                            foundUrls.forEach(url => {
                                urls.push({
                                    url,
                                    timestamp: message.createdTimestamp,
                                    author: message.author.tag,
                                    threadName: thread.name
                                });
                            });
                        }
                    });
                }
            } else {
                logWithTimestamp(`Fetching messages from regular channel: ${channelId}`, 'INFO');
                const messages = await channel.messages.fetch({ limit: 100 });
                
                messages.forEach(message => {
                    const foundUrls = message.content.match(this.urlRegex);
                    if (foundUrls) {
                        foundUrls.forEach(url => {
                            urls.push({
                                url,
                                timestamp: message.createdTimestamp,
                                author: message.author.tag
                            });
                        });
                    }
                });
            }
        } catch (error) {
            logWithTimestamp(`Error fetching messages: ${error.message}`, 'ERROR');
            return [];
        }

        urls = urls.filter((url, index, self) =>
            index === self.findIndex((t) => t.url === url.url)
        );

        logWithTimestamp(`Fetched ${urls.length} unique URLs from channel ${channelId}`, 'INFO');
        return urls;
    }

    async handleCommand(message) {
        if (!message.content.startsWith('!fetch links')) return;

        try {
            const args = message.content.split(' ');
            if (args.length !== 3) {
                await message.reply('Usage: !fetch links <channel_id>');
                return;
            }

            const channelId = args[2];
            const urls = await this.fetchAllUrlsFromChannel(channelId);

            if (urls.length === 0) {
                await message.reply('No URLs found in this channel.');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('URL History')
                .setDescription(`Found ${urls.length} URLs in channel`)
                .addFields(
                    urls.slice(0, 10).map(url => ({
                        name: `${new Date(url.timestamp).toLocaleString()} by ${url.author}${url.threadName ? ` in ${url.threadName}` : ''}`,
                        value: `${url.url.substring(0, 100)}${url.url.length > 100 ? '...' : ''}`
                    }))
                )
                .setFooter({
                    text: `Showing first 10 of ${urls.length} URLs`,
                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                });

            await message.reply({ embeds: [embed] });
        } catch (error) {
            logWithTimestamp(`Error handling command: ${error.message}`, 'ERROR');
            await message.reply('An error occurred while fetching URLs').catch(() => {});
        }
    }

    async handleUrlMessage(message, urls) {
    try {
        for (const url of urls) {
            const existingUrl = await this.urlStore.findUrlHistory(url);
            if (existingUrl) {
                    const embed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Duplicate URL Detected')
                        .setDescription(`This URL was previously shared on <t:${Math.floor(new Date(existingUrl.timestamp).getTime() / 1000)}:R>`)
                        .addFields(
                            { name: 'Original Poster', value: existingUrl.author || 'Unknown' },
                            { name: 'URL', value: url }
                        )
                        .setFooter({
                            text: 'Botanix Labs',
                            iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                        })
                        .setTimestamp();

                    await message.reply({ embeds: [embed] });
                } else {
                // Wait for DB_TIMEOUT period before adding to database
                setTimeout(async () => {
                    try {
                        // Fetch the message again to verify it still exists
                        const messageExists = await message.channel.messages.fetch(message.id)
                            .then(() => true)
                            .catch(() => false);

                        if (messageExists) {
                            // Only add to database if message still exists
                            await this.urlStore.addUrl(
                                url,
                                message.author.id,
                                message.channel.id,
                                message.channel.isThread() ? message.channel.id : null,
                                message.id,
                                message.author.tag
                            );
                            logWithTimestamp(`URL added after timeout: ${url}`, 'INFO');
                        } else {
                            logWithTimestamp(`Message no longer exists, URL not added: ${url}`, 'INFO');
                        }
                    } catch (error) {
                        logWithTimestamp(`Error checking message after timeout: ${error.message}`, 'ERROR');
                    }
                }, DB_TIMEOUT); // Use the DB_TIMEOUT value that's already defined
            }
        }
    } catch (error) {
        logWithTimestamp(`Error handling URL message: ${error.message}`, 'ERROR');
    }
}

    shutdown() {
        logWithTimestamp('URL Tracker shutting down...', 'SHUTDOWN');
    }
}

module.exports = UrlTracker;