require('dotenv').config();

// Database timeout configuration
const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1; // Default to 1 minute
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000; // Convert to milliseconds

// URL duplication age threshold (in minutes)
const THRESHOLD_DUPE_AGE = parseInt(process.env.THRESHOLD_DUPE_AGE) || 60; // Default to 60 minutes if not specified

module.exports = {
    DB_TIMEOUT,
    THRESHOLD_DUPE_AGE
};