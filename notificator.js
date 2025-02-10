require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');

// Initialize Discord client with required intents
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
const MAX_TEXT_LENGTH = 200;
const ERROR_COLOR = '#f2b518';
const RATE_LIMIT_COOLDOWN = 1000; // 1 seconds
const AUTO_DELETE_TIMER_SECONDS = parseInt(process.env.AUTO_DELETE_TIMER) || 30; // Default to 30 seconds
const AUTO_DELETE_TIMER = AUTO_DELETE_TIMER_SECONDS * 1000; // Convert to milliseconds

// Utility function for logging with timestamp
function logWithTimestamp(message, type = 'INFO') {
    const date = new Date();
    const timestamp = date.toISOString()
        .replace('T', ' ')      // Replace T with space
        .replace(/\.\d+Z$/, ''); // Remove milliseconds and Z
    console.log(`[${timestamp}] [${type}] ${message}`);
}

// Function to find highest role index (0-5) from user's roles
function findHighestRole(memberRoles) {
    // Loop through roles from highest (5) to lowest (0)
    for (let i = 5; i >= 0; i--) {
        const roleId = process.env[`ROLE_${i}_ID`];
        if (memberRoles.has(roleId)) {
            return i;
        }
    }
    return -1; // No matching role found
}

// Rate limiting
const rateLimitMap = new Map();

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

// Environment variable validation
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
        'AUTO_DELETE_TIMER'
    ];

    const missingVariables = requiredVariables.filter(varName => !process.env[varName]);
    if (missingVariables.length > 0) {
        logWithTimestamp(`Missing environment variables: ${missingVariables.join(', ')}`, 'ERROR');
        process.exit(1);
    }

    // Validate Discord IDs
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

    // Validate AUTO_DELETE_TIMER
    const timer = parseInt(process.env.AUTO_DELETE_TIMER);
    if (isNaN(timer) || timer < 0) {
        logWithTimestamp('Invalid AUTO_DELETE_TIMER value. Must be a positive number of seconds.', 'ERROR');
        process.exit(1);
    }
}

// Create mappings for roles and threads
const roleToThread = new Map([
    [process.env.ROLE_0_ID, process.env.THREAD_0_ID],
    [process.env.ROLE_1_ID, process.env.THREAD_1_ID],
    [process.env.ROLE_2_ID, process.env.THREAD_2_ID],
    [process.env.ROLE_3_ID, process.env.THREAD_3_ID],
    [process.env.ROLE_4_ID, process.env.THREAD_4_ID],
    [process.env.ROLE_5_ID, process.env.THREAD_5_ID]
]);

const threadToRole = new Map([
    [process.env.THREAD_0_ID, process.env.ROLE_0_ID],
    [process.env.THREAD_1_ID, process.env.ROLE_1_ID],
    [process.env.THREAD_2_ID, process.env.ROLE_2_ID],
    [process.env.THREAD_3_ID, process.env.ROLE_3_ID],
    [process.env.THREAD_4_ID, process.env.ROLE_4_ID],
    [process.env.THREAD_5_ID, process.env.ROLE_5_ID]
]);

// Create a Set of ignored roles
const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

// Cache for thread names
const threadNameCache = new Map();

// Utility function for getting thread name with caching
async function getThreadName(threadId) {
    if (threadNameCache.has(threadId)) {
        return threadNameCache.get(threadId);
    }

    try {
        const channel = await client.channels.fetch(threadId);
        if (!channel) {
            logWithTimestamp(`Thread ${threadId} not found`, 'ERROR');
            return threadId;
        }
        const threadName = channel.name;
        threadNameCache.set(threadId, threadName);
        return threadName;
    } catch (error) {
        logWithTimestamp(`Error fetching thread ${threadId}: ${error.message}`, 'ERROR');
        return threadId;
    }
}

// Check bot permissions in channel
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

// Event handler for when the bot is ready
client.once('ready', async () => {
    logWithTimestamp('Bot is ready and online!', 'STARTUP');
    logWithTimestamp(`Auto-delete timer set to ${AUTO_DELETE_TIMER_SECONDS} seconds`, 'CONFIG');
    
    // Initialize thread name cache and log monitored threads
    for (const threadId of threadToRole.keys()) {
        const threadName = await getThreadName(threadId);
        logWithTimestamp(`Monitoring thread: ${threadName}`, 'CONFIG');
    }
});

// Main message handler
client.on('messageCreate', async (message) => {
    try {
        // Basic checks
        if (message.author.bot) return;
        if (!message.guild || !message.member) return;
        if (!threadToRole.has(message.channel.id)) return;

        const threadName = await getThreadName(message.channel.id);
        logWithTimestamp(`Message received in "${threadName}" from ${message.author.tag}`, 'MESSAGE');

        // Rate limit check
        if (checkRateLimit(message.author.id)) {
            return;
        }

        // Permission check
        if (!checkBotPermissions(message.guild, message.channel)) {
            return;
        }

        // Check for ignored roles
        const hasIgnoredRole = message.member.roles.cache.some(role => 
            ignoredRoles.has(role.id)
        );
        if (hasIgnoredRole) {
            logWithTimestamp(`User ${message.author.tag} has an ignored role - message allowed in "${threadName}"`, 'ROLE');
            return;
        }

        // Find user's highest role
        const highestRoleIndex = findHighestRole(message.member.roles.cache);
        if (highestRoleIndex === -1) {
            logWithTimestamp(`User ${message.author.tag} has no matching roles`, 'ROLE');
            return;
        }

        // Get the thread ID that matches the user's highest role
        const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
        
        // If user is posting in the correct thread for their highest role, allow it
        if (message.channel.id === correctThreadId) {
            logWithTimestamp(`User ${message.author.tag} posted in correct thread for their highest role`, 'ACCESS');
            return;
        }

        // Prepare embed content
        const hasAttachments = message.attachments.size > 0;
        let embedDescription = hasAttachments 
            ? 'User uploaded file(s)'
            : message.content.length > MAX_TEXT_LENGTH
                ? message.content.substring(0, MAX_TEXT_LENGTH) + '...'
                : message.content || 'No content';

        // Create error embed
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
            logWithTimestamp(`User ${message.author.tag} posted in wrong thread "${threadName}"`, 'WARNING');
            
            // Send reply and handle message deletion
            const replyMessage = await message.reply({
                embeds: [errorEmbed]
            });

            // Wait briefly before deleting
            await new Promise(resolve => setTimeout(resolve, 500));

            if (message.deletable) {
                await message.delete();
                logWithTimestamp(`Deleted message from ${message.author.tag} in "${threadName}"`, 'MODERATION');
            }

            // Delete reply after the configured time
            if (AUTO_DELETE_TIMER_SECONDS > 0) {
                setTimeout(async () => {
                    try {
                        if (replyMessage.deletable) {
                            await replyMessage.delete();
                            logWithTimestamp(`Deleted reply message in "${threadName}"`, 'CLEANUP');
                        }
                    } catch (deleteError) {
                        logWithTimestamp(`Failed to delete reply message: ${deleteError.message}`, 'ERROR');
                    }
                }, AUTO_DELETE_TIMER);
            }
        } catch (replyError) {
            logWithTimestamp(`Failed to reply to message: ${replyError.message}`, 'ERROR');
            
            // Just try to delete the message if possible
            if (message.deletable) {
                try {
                    await message.delete();
                    logWithTimestamp(`Deleted message from ${message.author.tag}`, 'MODERATION');
                } catch (deleteError) {
                    logWithTimestamp(`Failed to delete message: ${deleteError.message}`, 'ERROR');
                }
            }
        }
    } catch (error) {
        logWithTimestamp(`Error processing message: ${error.message}`, 'ERROR');
        logWithTimestamp(`Error stack: ${error.stack}`, 'ERROR');
    }
});

// Error handling
client.on('error', error => {
    logWithTimestamp(`Client error: ${error.message}`, 'ERROR');
});

// Graceful shutdown handling
process.on('SIGINT', () => {
    logWithTimestamp('Received SIGINT. Shutting down gracefully...', 'SHUTDOWN');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logWithTimestamp('Received SIGTERM. Shutting down gracefully...', 'SHUTDOWN');
    client.destroy();
    process.exit(0);
});

// Validate environment variables before starting
validateEnvironmentVariables();

// Connect to Discord
client.login(process.env.DISCORD_TOKEN).catch(error => {
    logWithTimestamp(`Failed to login: ${error.message}`, 'FATAL');
    process.exit(1);
});