require('dotenv').config();

// Database timeout configuration
const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1; // Default to 1 minute
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000; // Convert to milliseconds

// Rate limiting configuration
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 5; // Default to 5 requests
const RATE_LIMIT_COOLDOWN = parseInt(process.env.RATE_LIMIT_COOLDOWN) || 1000; // Default to 1 second

module.exports = {
    DB_TIMEOUT,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_COOLDOWN
};