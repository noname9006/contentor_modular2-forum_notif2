const { EmbedBuilder, ChannelType } = require('discord.js');
const UrlStorage = require('./urlStore');
const { logWithTimestamp } = require('./utils');
const { DB_TIMEOUT, THRESHOLD_DUPE_AGE } = require('./config');

class UrlTracker {
    constructor(client, urlStore) {
        this.client = client;
        this.urlStore = urlStore; // Use the provided instance instead of creating a new one
        this.urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
    }

    async syncWithStorage(channelId) {
    try {
        // Skip fetching URLs during initialization
        // Only sync when explicitly requested after startup
        if (this.initializing) {
            logWithTimestamp(`Skipping URL sync for channel ${channelId} during initialization`, 'INFO');
            return;
        }
        
        const urls = await this.fetchAllUrlsFromChannel(channelId);
        if (urls.length > 0) {
            await this.urlStore.saveUrls(channelId, urls);
            logWithTimestamp(`Synced ${urls.length} URLs for channel ${channelId}`, 'INFO');
        }
    } catch (error) {
        logWithTimestamp(`Error syncing channel ${channelId}: ${error.message}`, 'ERROR');
    }
}

async init() {
    try {
        // Add a flag to track initialization state
        this.initializing = true;
        
        // Get channel IDs but don't sync during initialization
        const channelIds = await this.urlStore.getAllChannelIds();
        logWithTimestamp(`Found ${channelIds.length} channels in storage. Skipping sync during initialization.`, 'INFO');
        
        // Turn off initialization flag when complete
        this.initializing = false;
        
        logWithTimestamp('URL Tracker initialized successfully', 'INFO');
    } catch (error) {
        this.initializing = false;
        logWithTimestamp(`Failed to initialize URL Tracker: ${error.message}`, 'ERROR');
        throw error;
    }
}

    async handleUrlMessage(message, urls) {
        try {
            // Scenario 0: Check if any of the URLs contain BOTANIX_TWITTER value
            if (process.env.BOTANIX_TWITTER && process.env.BOTANIX_TWITTER.trim() !== '') {
                const botanixTwitterValue = process.env.BOTANIX_TWITTER.trim().toLowerCase();
                const containsBotanixTwitter = urls.some(url => 
                    url.toLowerCase().includes(botanixTwitterValue));
                
                if (containsBotanixTwitter) {
    logWithTimestamp(`Found Botanix Twitter URL: ${urls.join(', ')}`, 'INFO');
    const embed = new EmbedBuilder()
    .setColor('#ff0000')
    .setDescription(`<@${message.author.id}>, simply resharing Botanix tweets doesn't add much value\nPlease contribute with your own original content`)
    .setFooter({
        text: 'Botanix Labs',
        iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
    })


// Send as a reply instead of a standalone message
const replyMessage = await message.reply({ embeds: [embed] });

// Delete the user's message
if (message.deletable) {
    await message.delete();
}
    
    return [];
}
            }
            
            const urlsToStore = []; // Add this array to collect new URLs
            
            for (const url of urls) {
                logWithTimestamp(`Checking URL: ${url}`, 'INFO');
                const existingUrl = await this.urlStore.findUrlHistory(url);
                
                if (existingUrl) {
                    logWithTimestamp(`Found existing URL: ${url} from author: ${existingUrl.author}`, 'INFO'); 
                    
                    // Check if the original poster is the same as current author
                    if (existingUrl.author !== message.author.tag) {
                        // Different author - not allowed
                        const embed = new EmbedBuilder()
    .setColor('#ff0000')
    .setTitle('Please share only your own original content!')
    .setDescription(`${message.author}, this URL was previously shared by another user`)
    .addFields(
	{name: 'Original message:', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
        { name: 'URL:', value: url }
    )
    .setFooter({
        text: 'Botanix Labs',
        iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
    })

await message.reply({ embeds: [embed] });
await message.react('🚫'); // Add no_entry_sign reaction
logWithTimestamp(`Sent duplicate URL notification for: ${url}`, 'INFO');
                    } else {
                        // Same author - check if same thread
                        if (existingUrl.channelId !== message.channel.id) {
                            // Different thread
                            const embed = new EmbedBuilder()
                                .setColor('#ff0000')
                                .setTitle(`You have posted this before`)
                                .setDescription(`${message.author}, you shared this URL in a different thread`)
                                .addFields(
                                    { name: 'Original message:', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
                                    { name: 'URL:', value: url }
                                )
                                .setFooter({
                                    text: 'Botanix Labs',
                                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                                })

                            await message.reply({ embeds: [embed] });
							await message.react('🚫'); 
                            logWithTimestamp(`Sent same-author different-thread notification for: ${url}`, 'INFO');
                        } else {
                            // Same thread - check if original message exists
                            const originalMessage = await message.channel.messages
                                .fetch(existingUrl.messageId)
                                .catch(() => null);

                            if (originalMessage) {
                                // Original message still exists
                                const embed = new EmbedBuilder()
                                    .setColor('#ff0000')
                                    .setTitle(`${message.author}, You have posted this before`)
                                    .setDescription(`You already shared this URL in this thread on <t:${Math.floor(new Date(existingUrl.timestamp).getTime() / 1000)}:R>`)
                                    .addFields(
                                        { name: 'Original Message', value: `[Click to view](${originalMessage.url})` },
                                        { name: 'URL', value: url }
                                    )
                                    .setFooter({
                                        text: 'Botanix Labs',
                                        iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                                    })

                                await message.reply({ embeds: [embed] });
                                logWithTimestamp(`Sent same-thread notification for: ${url}`, 'INFO');
                            } else {
                                // Original message is gone - check age threshold
                                const currentTime = Date.now();
                                const originalTime = existingUrl.timestamp;
                                const ageInMinutes = (currentTime - originalTime) / (60 * 1000);
                                
                                if (ageInMinutes < THRESHOLD_DUPE_AGE) {
                                    // Less than threshold - treat as new URL
                                    await this.urlStore.deleteUrl(url);
                                    logWithTimestamp(`Deleted old URL entry as original message no longer exists and age (${ageInMinutes.toFixed(2)} min) is less than threshold: ${url}`, 'INFO');
                                    urlsToStore.push({
                                        url,
										timestamp: message.createdTimestamp,
										author: message.author.tag,
										authorId: message.author.id,
										threadName: message.channel.name,
										threadId: message.channel.id,                      // Explicit thread ID
										forumChannelId: message.channel.parent?.id,        // Parent forum channel ID
										messageId: message.id,
										messageUrl: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
										guildId: message.guild.id
									});
                                } else {
                                    // More than threshold - send warning as duplicate
                                    const embed = new EmbedBuilder()
                                        .setColor('#ff0000')
                                        .setTitle(`${message.author}, You have posted this before`)
                                        .setDescription(`You already shared this URL in this thread on <t:${Math.floor(new Date(existingUrl.timestamp).getTime() / 1000)}:R>`)
                                        .addFields(
                                            { name: 'Original Message', value: `Original message was deleted` },
                                            { name: 'URL', value: url },
                                            { name: 'Age', value: `${ageInMinutes.toFixed(2)} minutes` }
                                        )
                                        .setFooter({
                                            text: 'Botanix Labs',
                                            iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                                        })

                                    await message.reply({ embeds: [embed] });
                                    logWithTimestamp(`Sent same-thread notification for deleted message with age (${ageInMinutes.toFixed(2)} min) exceeding threshold: ${url}`, 'INFO');
                                }
                            }
                        }
                    }
                } else {
                    // New URL - add it to store
                    urlsToStore.push({
                        url,
                        timestamp: message.createdTimestamp,
                        author: message.author.tag,
                        authorId: message.author.id,
                        threadName: message.channel.name,
                        threadId: message.channel.id,
                        messageId: message.id,
                        guildId: message.guild.id
                    });
                }
            }
            
            // Store new URLs if any
            if (urlsToStore.length > 0) {
                try {
                    await this.urlStore.saveUrls(message.channel.id, urlsToStore);
                } catch (error) {
                    logWithTimestamp(`Failed to store URLs: ${error.message}`, 'ERROR');
                }
            }
            
            return urlsToStore; // Return the stored URLs for reference
        } catch (error) {
            logWithTimestamp(`Error handling URL message: ${error.message}`, 'ERROR');
            return [];
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
                const threads = await channel.threads.fetch();
                
                for (const [threadId, thread] of threads.threads) {
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

    shutdown() {
        logWithTimestamp('URL Tracker shutting down...', 'SHUTDOWN');
        // No need to call urlStore.shutdown() here as it's managed externally
    }
}

module.exports = UrlTracker;