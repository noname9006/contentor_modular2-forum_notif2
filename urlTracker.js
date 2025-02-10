const { EmbedBuilder, ChannelType } = require('discord.js');
const UrlStore = require('./urlStore');
const { logWithTimestamp } = require('./utils');

class UrlTracker {
    // ... (previous constructor and init methods remain the same)

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
                // Handle forum channel
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
                // Handle regular channel
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

        // Remove duplicates
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
            logWithTimestamp(`Error handling fetch command: ${error.message}`, 'ERROR');
            await message.reply('An error occurred while fetching URLs');
        }
    }

    // ... (rest of the class methods remain the same)
}

module.exports = UrlTracker;