require('dotenv').config();

const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1; // Default to 1 minute
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000; // Convert to milliseconds

module.exports = {
    DB_TIMEOUT
};