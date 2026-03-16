require('dotenv').config();

// Database timeout configuration
const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1; // Default to 1 minute
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000; // Convert to milliseconds

// Rate limiting configuration
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 5; // Default to 5 requests
const RATE_LIMIT_COOLDOWN = parseInt(process.env.RATE_LIMIT_COOLDOWN) || 1000; // Default to 1 second

// URL duplication age threshold (in minutes)
const THRESHOLD_DUPE_AGE = parseInt(process.env.THRESHOLD_DUPE_AGE) || 60; // Default to 60 minutes if not specified

// Whether role-to-thread routing and role-based cleanup is enabled
const ROLE_TO_THREAD_ENABLED = (process.env.ROLE_TO_THREAD || 'on').toLowerCase() === 'on';

// Days of inactivity after which a user is removed from a thread (time-based cleanup)
const THREAD_INACTIVITY_DAYS = parseInt(process.env.THREAD_INACTIVITY_DAYS) || 30;

// Cron schedule for thread cleanup (default: every 6 hours)
const THREAD_CLEANUP_SCHEDULE = process.env.THREAD_CLEANUP_SCHEDULE || '0 */6 * * *';

module.exports = {
    DB_TIMEOUT,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_COOLDOWN,
    THRESHOLD_DUPE_AGE,
    ROLE_TO_THREAD_ENABLED,
    THREAD_INACTIVITY_DAYS,
    THREAD_CLEANUP_SCHEDULE
};