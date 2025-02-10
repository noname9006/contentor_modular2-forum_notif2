require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const UrlTracker = require('./urlTracker');
const { logWithTimestamp } = require('./utils');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

const MAX_TEXT_LENGTH = 200;
const ERROR_COLOR = '#f2b518';
const RATE_LIMIT_COOLDOWN = 1000;
const AUTO_DELETE_TIMER_SECONDS = parseInt(process.env.AUTO_DELETE_TIMER) || 30;
const AUTO_DELETE_TIMER = AUTO_DELETE_TIMER_SECONDS * 1000;
const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1;
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000;

const rateLimitMap = new Map();

function findHighestRole(memberRoles) {
    for (let i = 5; i >= 0; i--) {
        const roleId = process.env[`ROLE_${i}_ID`];
        if (memberRoles.has(roleId)) {
            return i;
        }
    }
    return -1;
}

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
    ];

    const missingVariables = requiredVariables.filter(varName => !process.env[varName]);
    if (missingVariables.length > 0) {
        logWithTimestamp(`Missing environment variables: ${missingVariables.join(', ')}`, 'ERROR');
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
        if (!channel) {
            return threadId;
        }
        const threadName = channel.name;
        threadNameCache.set(threadId, threadName);
        return threadName;
    } catch (error) {
        return threadId;
    }
}

const urlTracker = new UrlTracker(client);

client.once('ready', async () => {
    try {
        await urlTracker.init();
        logWithTimestamp(`Bot is online`, 'STARTUP');
        logWithTimestamp(`Auto-delete timer: ${AUTO_DELETE_TIMER_SECONDS}s`, 'CONFIG');
        
        for (const threadId of threadToRole.keys()) {
            const threadName = await getThreadName(threadId);
            logWithTimestamp(`Monitoring: ${threadName}`, 'CONFIG');
        }
    } catch (error) {
        logWithTimestamp(`Initialization error: ${error.message}`, 'FATAL');
        process.exit(1);
    }
});

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild || !message.member) return;

        if (message.content.startsWith('!fetch links')) {
            await urlTracker.handleCommand(message);
            return;
        }

        if (!threadToRole.has(message.channel.id)) return;

        const threadName = await getThreadName(message.channel.id);

        if (checkRateLimit(message.author.id)) return;

        const hasIgnoredRole = message.member.roles.cache.some(role => 
            ignoredRoles.has(role.id)
        );
        if (hasIgnoredRole) return;

        const highestRoleIndex = findHighestRole(message.member.roles.cache);
        if (highestRoleIndex === -1) return;

        const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
        
        if (message.channel.id === correctThreadId) {
            const urls = message.content.match(urlTracker.urlRegex);
            if (urls) {
                await urlTracker.handleUrlMessage(message, urls);
            }
            return;
        }

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
                        // Silently handle delete errors
                    }
                }, AUTO_DELETE_TIMER);
            }
        } catch (error) {
            if (message.deletable) {
                try {
                    await message.delete();
                } catch (error) {
                    // Silently handle delete errors
                }
            }
        }
    } catch (error) {
        logWithTimestamp(`Error: ${error.message}`, 'ERROR');
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