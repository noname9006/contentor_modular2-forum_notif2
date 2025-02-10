function logWithTimestamp(message, type = 'INFO') {
    const date = new Date();
    const timestamp = date.toISOString()
        .replace('T', ' ')      // Replace T with space
        .replace(/\.\d+Z$/, ''); // Remove milliseconds and Z
    console.log(`[${timestamp}] [${type}] ${message}`);
}

module.exports = {
    logWithTimestamp
};