require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials, ChannelType } = require('discord.js');
const UrlStorage = require('./urlStore');
const UrlTracker = require('./urlTracker');
const { logWithTimestamp } = require('./utils');
const { DB_TIMEOUT } = require('./config');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

// Constants
const MAX_TEXT_LENGTH = 300;
const ERROR_COLOR = '#f2b518';
const AUTO_DELETE_TIMER_SECONDS = parseInt(process.env.AUTO_DELETE_TIMER) || 30;
const AUTO_DELETE_TIMER = AUTO_DELETE_TIMER_SECONDS * 1000;
const URL_CHECK_TIMEOUT = parseInt(process.env.URL_CHECK_TIMEOUT) || 5000;
const MAX_FETCH_RETRIES = 3;
const CACHE_CLEANUP_INTERVAL = 300000; // 5 minutes
const THREAD_CACHE_TTL = 3600000; // 1 hour
const URL_HISTORY_LIMIT = 10;

// Rate limiting and caching
const rateLimitMap = new Map();
const threadNameCache = new Map(); // Stores {threadId: {name: string, timestamp: number, pendingOps: number}}

function findHighestRole(memberRoles) {
    for (let i = 5; i >= 0; i--) {
        const roleId = process.env[`ROLE_${i}_ID`];
        if (memberRoles.has(roleId)) {
            return i;
        }
    }
    return -1;
}

function validateEnvironmentVariables() {
    const requiredVariables = [
        'DISCORD_TOKEN',
        'MAIN_CHANNEL_ID',
        'AUTO_DELETE_TIMER',
        'DB_TIMEOUT',
        ...Array.from({length: 6}, (_, i) => `ROLE_${i}_ID`),
        ...Array.from({length: 6}, (_, i) => `THREAD_${i}_ID`)
    ];

    const missingVariables = requiredVariables.filter(varName => !process.env[varName]);
    if (missingVariables.length > 0) {
        logWithTimestamp(`Missing environment variables: ${missingVariables.join(', ')}`, 'ERROR');
        process.exit(1);
    }

    const idVariables = [
        'MAIN_CHANNEL_ID',
        ...Array.from({length: 6}, (_, i) => `ROLE_${i}_ID`),
        ...Array.from({length: 6}, (_, i) => `THREAD_${i}_ID`)
    ];

    idVariables.forEach(varName => {
        const value = process.env[varName];
        if (!/^\d+$/.test(value)) {
            logWithTimestamp(`Invalid Discord ID format for ${varName}: ${value}`, 'ERROR');
            process.exit(1);
        }
    });

    if (isNaN(parseInt(process.env.AUTO_DELETE_TIMER)) || parseInt(process.env.AUTO_DELETE_TIMER) < 0) {
        logWithTimestamp('Invalid AUTO_DELETE_TIMER value. Must be a positive number.', 'ERROR');
        process.exit(1);
    }

    if (isNaN(parseInt(process.env.DB_TIMEOUT)) || parseInt(process.env.DB_TIMEOUT) < 0) {
        logWithTimestamp('Invalid DB_TIMEOUT value. Must be a positive number.', 'ERROR');
        process.exit(1);
    }
}

function checkBotPermissions(guild, channel) {
    const botMember = guild.members.cache.get(client.user.id);
    if (!botMember) {
        logWithTimestamp('Bot member not found in guild', 'ERROR');
        return false;
    }

    const requiredPermissions = [
        'ViewChannel',
        'SendMessages',
        'ManageMessages',
        'EmbedLinks'
    ];

    const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
    if (missingPermissions.length > 0) {
        logWithTimestamp(`Missing permissions in ${channel.name}: ${missingPermissions.join(', ')}`, 'ERROR');
        return false;
    }

    return true;
}

const roleToThread = new Map();
const threadToRole = new Map();

function initializeMappings() {
    for (let i = 0; i <= 5; i++) {
        const roleId = process.env[`ROLE_${i}_ID`];
        const threadId = process.env[`THREAD_${i}_ID`];
        roleToThread.set(roleId, threadId);
        threadToRole.set(threadId, roleId);
    }
}

const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

async function getThreadName(threadId) {
    const cacheEntry = threadNameCache.get(threadId);
    if (cacheEntry) {
        cacheEntry.pendingOps++;
        return {
            name: cacheEntry.name,
            done: () => {
                const entry = threadNameCache.get(threadId);
                if (entry) {
                    entry.pendingOps--;
                }
            }
        };
    }

    try {
        const channel = await client.channels.fetch(threadId);
        if (!channel) {
            return { name: threadId, done: () => {} };
        }
        
        threadNameCache.set(threadId, {
            name: channel.name,
            timestamp: Date.now(),
            pendingOps: 1
        });
        
        return {
            name: channel.name,
            done: () => {
                const entry = threadNameCache.get(threadId);
                if (entry) {
                    entry.pendingOps--;
                }
            }
        };
    } catch (error) {
        logWithTimestamp(`Error fetching thread ${threadId}: ${error.message}`, 'ERROR');
        return { name: threadId, done: () => {} };
    }
}

async function isMessageInForumPost(message) {
    try {
        const channel = message.channel;
        if (!channel.isThread()) return false;
        
        const parent = await channel.parent?.fetch();
        return parent?.id === process.env.MAIN_CHANNEL_ID &&
               parent?.type === ChannelType.GuildForum;
    } catch (error) {
        logWithTimestamp(`Error checking forum post: ${error.message}`, 'ERROR');
        return false;
    }
}

async function checkMessageExists(message, retries = 0) {
    try {
        return await message.channel.messages.fetch(message.id)
            .then(() => true)
            .catch(async (error) => {
                if (retries < MAX_FETCH_RETRIES && error.code === 'NETWORK_ERROR') {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return checkMessageExists(message, retries + 1);
                }
                return false;
            });
    } catch {
        return false;
    }
}

async function handleWrongThread(message, correctThreadId) {
    const hasAttachments = message.attachments.size > 0;
    let embedDescription = hasAttachments 
        ? 'User uploaded file(s)'
        : message.content.length > MAX_TEXT_LENGTH
            ? message.content.substring(0, MAX_TEXT_LENGTH) + '...'
            : message.content || 'No content';

    const errorEmbed = new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription(`${message.author}, please use the thread that matches your highest role.\nYour message has been removed because it was posted to a wrong thread.`)
        .addFields(
            {
                name: "Here's the right one for you:",
                value: `<#${correctThreadId}>`
            },
            { 
                name: 'Your message content:', 
                value: embedDescription
            }
        )
        .setFooter({
            text: 'Botanix Labs',
            iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
        })
        .setTimestamp();

    try {
        const replyMessage = await message.reply({ embeds: [errorEmbed] });
        if (message.deletable) {
            await message.delete();
        }

        if (AUTO_DELETE_TIMER > 0) {
            setTimeout(async () => {
                try {
                    if (replyMessage.deletable) {
                        await replyMessage.delete();
                    }
                } catch (error) {
                    logWithTimestamp(`Error deleting reply: ${error.message}`, 'ERROR');
                }
            }, AUTO_DELETE_TIMER);
        }
    } catch (error) {
        logWithTimestamp(`Error handling wrong thread: ${error.message}`, 'ERROR');
        if (message.deletable) {
            await message.delete().catch(() => {});
        }
    }
}

async function handleFetchLinksCommand(message) {
    try {
        const args = message.content.split(' ');
        if (args.length !== 3) {
            await message.reply('Usage: !fetch links <channel_id>');
            return;
        }

        const channelId = args[2];
        
        const targetChannel = await client.channels.fetch(channelId).catch(() => null);
        if (!targetChannel) {
            await message.reply('Channel not found or bot has no access to it.');
            return;
        }

        logWithTimestamp(`Fetching URLs from channel ${channelId}`, 'INFO');
        
        let urls = [];
        try {
            // First get stored URLs
            const storedUrls = await urlStore.getUrls(channelId);
            urls = [...storedUrls];

            // Then fetch new URLs
            if (targetChannel.type === ChannelType.GuildForum) {
                const threads = await targetChannel.threads.fetch();
                
                for (const [threadId, thread] of threads.threads) {
                    const messages = await thread.messages.fetch({ limit: 100 });
                    messages.forEach(msg => {
                        const foundUrls = msg.content.match(urlTracker.urlRegex);
                        if (foundUrls) {
                            const messageUrl = `https://discord.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
                            foundUrls.forEach(url => {
    urls.push({
        url,
        timestamp: msg.createdTimestamp,
        userId: msg.author.id,
        author: msg.author.tag,
        threadId: msg.channel.id,            // The thread ID (previously called channelId)
        forumChannelId: msg.channel.parent?.id || null,  // The parent forum channel ID
        messageId: msg.id,
        messageUrl: messageUrl
    });
});
						}
                    });
                }
			}
            else {
    const messages = await targetChannel.messages.fetch({ limit: 100 });
    messages.forEach(msg => {
        const foundUrls = msg.content.match(urlTracker.urlRegex);
        if (foundUrls) {
            const messageUrl = `https://discord.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
            foundUrls.forEach(url => {
                urls.push({
                    url,
                    timestamp: msg.createdTimestamp,
                    userId: msg.author.id,
                    author: msg.author.tag,
                    messageId: msg.id,
                    messageUrl: messageUrl,
                    channelId: msg.channel.id,               // Keep for backwards compatibility 
                    threadId: msg.channel.isThread() ? msg.channel.id : null,
                    forumChannelId: msg.channel.isThread() ? msg.channel.parent?.id : null
                });
            });
        }
    });
}

            // Sort by timestamp (removed duplicate filtering)
            urls = urls.sort((a, b) => a.timestamp - b.timestamp);

            // Save updated URLs with retries
            let saved = false;
            let retries = 3;
            while (!saved && retries > 0) {
                try {
                    await urlStore.saveUrls(channelId, urls);
                    saved = true;
                    logWithTimestamp(`Successfully saved ${urls.length} URLs for channel ${channelId}`, 'INFO');
                } catch (error) {
                    retries--;
                    if (retries === 0) {
                        throw error;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            if (urls.length === 0) {
                await message.reply('No URLs found in this channel.');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('URLs fetched')
                .setDescription(`Found and saved ${urls.length} URLs in channel: ${channelId}`)
                .addFields(
                    { 
                        name: 'Storage Status', 
                        value: saved ? '✅ URLs saved successfully' : '❌ Failed to save URLs'
                    }
                )
                .setFooter({
                    text: 'Botanix Labs',
                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                })
                .setTimestamp();

            await message.reply({ embeds: [embed] });
            logWithTimestamp(`Fetched and saved ${urls.length} URLs from channel ${channelId}`, 'INFO');
        } catch (error) {
            logWithTimestamp(`Error fetching URLs: ${error.message}`, 'ERROR');
            await message.reply('An error occurred while fetching URLs.');
        }
    } catch (error) {
        logWithTimestamp(`Error handling fetch links command: ${error.message}`, 'ERROR');
        await message.reply('An error occurred while processing the command.').catch(() => {});
    }
}

// Cache cleanup
setInterval(() => {
    const now = Date.now();
        // Clean up thread name cache
    for (const [threadId, data] of threadNameCache.entries()) {
                if (now - data.timestamp > THREAD_CACHE_TTL && data.pendingOps === 0) {
            threadNameCache.delete(threadId);
        }
    }
}, CACHE_CLEANUP_INTERVAL);

// Create instances - MODIFIED: Create a single UrlStorage instance and pass it to UrlTracker
const urlStore = new UrlStorage();
const urlTracker = new UrlTracker(client, urlStore); // Pass the existing instance

client.once('ready', async () => {
    try {
        await urlStore.init();  // Initialize urlStore first
        await urlTracker.init(); // Then initialize urlTracker
        initializeMappings();
        
        const mainChannel = await client.channels.fetch(process.env.MAIN_CHANNEL_ID);
        if (!mainChannel || mainChannel.type !== ChannelType.GuildForum) {
            throw new Error('MAIN_CHANNEL_ID must be a forum channel');
        }
        
        logWithTimestamp('Bot initialized successfully', 'STARTUP');
        logWithTimestamp(`Monitoring forum channel: ${mainChannel.name}`, 'CONFIG');
        // Remove this line:
        // logWithTimestamp(`Last updated: 2025-03-12 18:14:35 UTC by noname9006`, 'INFO');

        // URL cleanup has been disabled
        logWithTimestamp('URL cleanup has been disabled - URLs will be kept forever', 'CONFIG');
        
    } catch (error) {
        logWithTimestamp(`Initialization error: ${error.message}`, 'FATAL');
        process.exit(1);
    }
});

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot || !message.guild || !message.member) return;

        // Handle fetch links command before forum post check
        if (message.content.startsWith('!fetch links')) {
            await handleFetchLinksCommand(message);
            return;
        }

        const isForumPost = await isMessageInForumPost(message);
        if (!isForumPost) return;

        if (!checkBotPermissions(message.guild, message.channel)) {
            logWithTimestamp(`Insufficient permissions in channel ${message.channel.name}`, 'ERROR');
            return;
        }

        const threadNameData = await getThreadName(message.channel.id);
        try {
            if (checkRateLimit(message.author.id)) return;

            if (message.member.roles.cache.some(role => ignoredRoles.has(role.id))) return;

            const highestRoleIndex = findHighestRole(message.member.roles.cache);
            if (highestRoleIndex === -1) return;

            const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
            
            if (message.channel.id !== correctThreadId) {
                await handleWrongThread(message, correctThreadId);
                return;
            }

            const urls = message.content.match(urlTracker.urlRegex);
            if (urls) {
                // Create a function for the timeout callback
                const checkAndStoreUrls = async () => {
                    try {
                        const messageExists = await checkMessageExists(message);
                        if (messageExists) {
                            await urlTracker.handleUrlMessage(message, urls);
                        } else {
                            logWithTimestamp(`Message ${message.id} no longer exists, skipping URL check`, 'INFO');
                        }
                    } catch (error) {
                        logWithTimestamp(`Error in URL check: ${error.message}`, 'ERROR');
                    }
                };

                // Set the timeout with the async function
                setTimeout(checkAndStoreUrls, URL_CHECK_TIMEOUT);
            }
        } finally {
            threadNameData.done();
        }
    } catch (error) {
        logWithTimestamp(`Error processing message: ${error.message}`, 'ERROR');
    }
});

client.on('error', error => {
    logWithTimestamp(`Client error: ${error.message}`, 'ERROR');
});

process.on('uncaughtException', error => {
    logWithTimestamp(`Fatal error: ${error.message}`, 'FATAL');
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    logWithTimestamp(`Unhandled rejection: ${reason}`, 'ERROR');
    try {
        await promise;
    } catch (error) {
        logWithTimestamp(`Failed to handle rejection: ${error}`, 'ERROR');
    }
});

process.on('SIGINT', () => {
    logWithTimestamp('Shutting down...', 'SHUTDOWN');
    urlStore.shutdown();
    urlTracker.shutdown();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logWithTimestamp('Shutting down...', 'SHUTDOWN');
    urlStore.shutdown();
    urlTracker.shutdown();
    client.destroy();
    process.exit(0);
});

validateEnvironmentVariables();

client.login(process.env.DISCORD_TOKEN).catch(error => {
    logWithTimestamp(`Login failed: ${error.message}`, 'FATAL');
    process.exit(1);
});