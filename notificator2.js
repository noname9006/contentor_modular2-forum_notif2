require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials, ChannelType } = require('discord.js');
const UrlTracker = require('./urlTracker');
const { logWithTimestamp } = require('./utils');
const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1; // Default to 1 minute
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000; // Convert to milliseconds
const MAX_TEXT_LENGTH = 200;
const ERROR_COLOR = '#f2b518';
const RATE_LIMIT_COOLDOWN = 1000;
const AUTO_DELETE_TIMER_SECONDS = parseInt(process.env.AUTO_DELETE_TIMER) || 30;
const AUTO_DELETE_TIMER = AUTO_DELETE_TIMER_SECONDS * 1000;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

function findHighestRole(memberRoles) {
    for (let i = 5; i >= 0; i--) {
        const roleId = process.env[`ROLE_${i}_ID`];
        if (memberRoles.has(roleId)) {
            return i;
        }
    }
    return -1;
}

const rateLimitMap = new Map();

let initialized = false;

// In the ready event
client.once('ready', async () => {
    try {
        if (initialized) return;
        await urlTracker.init();
        initialized = true;
        logWithTimestamp('Bot is ready and online!', 'STARTUP');
        logWithTimestamp(`Auto-delete timer: ${AUTO_DELETE_TIMER_SECONDS}s`, 'CONFIG');
        
        for (const threadId of threadToRole.keys()) {
            const threadName = await getThreadName(threadId);
            logWithTimestamp(`Monitoring: ${threadName}`, 'CONFIG');
        }
    } catch (error) {
        logWithTimestamp(`Error during initialization: ${error.message}`, 'FATAL');
        process.exit(1);
    }
});

function checkRateLimit(userId) {
    const now = Date.now();
    const userRateLimit = rateLimitMap.get(userId);
    
    if (userRateLimit && now - userRateLimit < RATE_LIMIT_COOLDOWN) {
        logWithTimestamp(`Rate limit hit for user ID: ${userId}`, 'RATELIMIT');
        return true;
    }
    
    rateLimitMap.set(userId, now);
    return false;
}

function validateEnvironmentVariables() {
    const requiredVariables = [
        'DISCORD_TOKEN',
        'ROLE_0_ID',
        'ROLE_1_ID',
        'ROLE_2_ID',
        'ROLE_3_ID',
        'ROLE_4_ID',
        'ROLE_5_ID',
        'THREAD_0_ID',
        'THREAD_1_ID',
        'THREAD_2_ID',
        'THREAD_3_ID',
        'THREAD_4_ID',
        'THREAD_5_ID',
        'AUTO_DELETE_TIMER',
        'DB_TIMEOUT'
    ];

    const missingVariables = requiredVariables.filter(varName => !process.env[varName]);
    if (missingVariables.length > 0) {
        logWithTimestamp(`Missing environment variables: ${missingVariables.join(', ')}`, 'ERROR');
        process.exit(1);
    }

    const idVariables = Object.keys(process.env).filter(key => 
        (key.startsWith('ROLE_') || key.startsWith('THREAD_')) && key.endsWith('_ID')
    );

    idVariables.forEach(varName => {
        const value = process.env[varName];
        if (!/^\d+$/.test(value)) {
            logWithTimestamp(`Invalid Discord ID format for ${varName}: ${value}`, 'ERROR');
            process.exit(1);
        }
    });

    const timer = parseInt(process.env.AUTO_DELETE_TIMER);
    const dbTimeout = parseInt(process.env.DB_TIMEOUT);
    if (isNaN(timer) || timer < 0) {
        logWithTimestamp('Invalid AUTO_DELETE_TIMER value. Must be a positive number of seconds.', 'ERROR');
        process.exit(1);
    }
    if (isNaN(dbTimeout) || dbTimeout < 0) {
        logWithTimestamp('Invalid DB_TIMEOUT value. Must be a positive number of minutes.', 'ERROR');
        process.exit(1);
    }
}

const roleToThread = new Map();
const threadToRole = new Map();

for (let i = 0; i <= 5; i++) {
    const roleId = process.env[`ROLE_${i}_ID`];
    const threadId = process.env[`THREAD_${i}_ID`];
    roleToThread.set(roleId, threadId);
    threadToRole.set(threadId, roleId);
}

const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

const threadNameCache = new Map();

async function getThreadName(threadId) {
    if (threadNameCache.has(threadId)) {
        return threadNameCache.get(threadId);
    }

    try {
        const channel = await client.channels.fetch(threadId);
        if (!channel) return threadId;
        const threadName = channel.name;
        threadNameCache.set(threadId, threadName);
        return threadName;
    } catch (error) {
        return threadId;
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

const urlTracker = new UrlTracker(client);

client.once('ready', async () => {
    try {
        await urlTracker.init();
        logWithTimestamp('Bot is ready and online!', 'STARTUP');
        logWithTimestamp(`Auto-delete timer: ${AUTO_DELETE_TIMER_SECONDS}s`, 'CONFIG');
        
        for (const threadId of threadToRole.keys()) {
            const threadName = await getThreadName(threadId);
            logWithTimestamp(`Monitoring: ${threadName}`, 'CONFIG');
        }
    } catch (error) {
        logWithTimestamp(`Error during initialization: ${error.message}`, 'FATAL');
        process.exit(1);
    }
});

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild || !message.member) return;

        // Handle URL fetch command first
        if (message.content.startsWith('!fetch links')) {
            try {
                await urlTracker.handleCommand(message);
            } catch (error) {
                logWithTimestamp(`Error handling fetch command: ${error.message}`, 'ERROR');
                await message.reply('An error occurred while fetching URLs').catch(() => {});
            }
            return;
        }

        // Check for URLs in any message
        const urls = message.content.match(urlTracker.urlRegex);
        if (urls) {
            try {
                await urlTracker.handleUrlMessage(message, urls);
            } catch (error) {
                logWithTimestamp(`Error handling URLs: ${error.message}`, 'ERROR');
            }
        }
        // If not in a monitored thread, we're done
        if (!threadToRole.has(message.channel.id)) return;

        // Rate limit check
        if (checkRateLimit(message.author.id)) return;

        // Permission check
        if (!checkBotPermissions(message.guild, message.channel)) return;

        // Check for ignored roles
        const hasIgnoredRole = message.member.roles.cache.some(role => 
            ignoredRoles.has(role.id)
        );
        if (hasIgnoredRole) return;

        // Find user's highest role
        const highestRoleIndex = findHighestRole(message.member.roles.cache);
        if (highestRoleIndex === -1) return;

        const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
        
        // If in correct thread, we're done
        if (message.channel.id === correctThreadId) return;

        // Handle wrong thread posting
        const hasAttachments = message.attachments.size > 0;
        let embedDescription = hasAttachments 
            ? 'User uploaded file(s)'
            : message.content.length > MAX_TEXT_LENGTH
                ? message.content.substring(0, MAX_TEXT_LENGTH) + '...'
                : message.content || 'No content';

        const errorEmbed = new EmbedBuilder()
            .setColor(ERROR_COLOR)
            .setDescription(`${message.author}, please use the thread that matches your highest role.
Your message has been removed because it was posted to a wrong thread.`)
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
                        // Silent error handling for cleanup
                    }
                }, AUTO_DELETE_TIMER);
            }
        } catch (error) {
            if (message.deletable) {
                try {
                    await message.delete();
                } catch (error) {
                    // Silent error handling for cleanup
                }
            }
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

process.on('unhandledRejection', (reason, promise) => {
    logWithTimestamp(`Unhandled rejection: ${reason}`, 'FATAL');
    process.exit(1);
});

process.on('SIGINT', () => {
    logWithTimestamp('Shutting down...', 'SHUTDOWN');
    urlTracker.shutdown();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logWithTimestamp('Shutting down...', 'SHUTDOWN');
    urlTracker.shutdown();
    client.destroy();
    process.exit(0);
});

validateEnvironmentVariables();

client.login(process.env.DISCORD_TOKEN).catch(error => {
    logWithTimestamp(`Login failed: ${error.message}`, 'FATAL');
    process.exit(1);
});
module.exports = {
    DB_TIMEOUT,
   };