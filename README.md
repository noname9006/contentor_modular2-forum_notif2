# Contentor — Discord Forum Notification & URL Tracker Bot

A modular Discord bot that monitors forum channels, tracks shared URLs, enforces role-based thread routing, and prevents duplicate content submissions.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Bot](#running-the-bot)
- [Commands](#commands)
- [URL Duplicate Detection Logic](#url-duplicate-detection-logic)
- [Architecture](#architecture)
- [Data Storage](#data-storage)
- [Project Structure](#project-structure)

---

## Overview

Contentor is a Node.js Discord bot built for community forum management. It watches a designated forum channel and automatically:

- Detects URLs posted in threads
- Prevents users from re-submitting previously shared links
- Enforces that users post in the thread that matches their assigned role tier
- Logs violations to a dedicated log channel
- Optionally blocks links to a configurable Twitter/X account

---

## Features

- **URL tracking** — Stores every URL shared in a forum channel with full metadata (author, thread, timestamp, message link)
- **Duplicate detection** — Catches cross-user duplicates and same-user reposts across threads or within the same thread
- **Role-based thread routing** — Maps six permission tiers (roles) to six corresponding threads and warns users who post in the wrong one (can be disabled via `ROLE_TO_THREAD=off`)
- **Configurable Twitter/X block** — Optionally deletes messages containing a specific Twitter URL pattern and warns the author
- **Admin fetch command** — Bulk-imports existing URLs from any channel into the database
- **Violation logging** — Sends detailed log embeds (with evidence links) to a dedicated log channel
- **Rate limiting** — Per-user request throttling to prevent abuse
- **Thread cleanup** — Scheduled removal of inactive or mismatched users from configured threads
- **Activity tracking** — Records last-post timestamp per user per thread, persisted to disk
- **Graceful shutdown** — Saves state and cleans up on SIGINT/SIGTERM

---

## Prerequisites

- **Node.js** v16.9.0 or later
- **npm** v7 or later
- A Discord application/bot token with the following intents enabled in the [Discord Developer Portal](https://discord.com/developers/applications):
  - `GUILDS`
  - `GUILD_MESSAGES`
  - `MESSAGE_CONTENT`

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/noname9006/contentor_modular2-forum_notif2.git
cd contentor_modular2-forum_notif2

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env   # or create .env manually (see Configuration)
```

---

## Configuration

All configuration is done through environment variables. Create a `.env` file in the project root:

```dotenv
# ── Required ────────────────────────────────────────────────────────────────

# Discord bot token (from Discord Developer Portal)
DISCORD_TOKEN=your_bot_token_here

# The forum channel ID to monitor for new messages
MAIN_CHANNEL_ID=123456789012345678

# ── Timing ──────────────────────────────────────────────────────────────────

# Seconds before the bot auto-deletes its own warning replies (default: 30)
AUTO_DELETE_TIMER=30

# Database lock/timeout in minutes (default: 1)
DB_TIMEOUT=1

# Milliseconds to wait before processing URLs in a new message (default: 5000)
URL_CHECK_TIMEOUT=5000

# ── Role-to-Thread Mapping (6 tiers, 0–5) ───────────────────────────────────
# Each ROLE_N maps to THREAD_N. Users with ROLE_N should post in THREAD_N.
# Required only when ROLE_TO_THREAD=on (the default).

ROLE_0_ID=111111111111111111
ROLE_1_ID=222222222222222222
ROLE_2_ID=333333333333333333
ROLE_3_ID=444444444444444444
ROLE_4_ID=555555555555555555
ROLE_5_ID=666666666666666666

THREAD_0_ID=777777777777777777
THREAD_1_ID=888888888888888888
THREAD_2_ID=999999999999999999
THREAD_3_ID=101010101010101010
THREAD_4_ID=111111111111111112
THREAD_5_ID=121212121212121212

# ── Thread Cleanup ────────────────────────────────────────────────────────────

# Enable or disable role-to-thread routing and role-based cleanup (default: on)
ROLE_TO_THREAD=on

# Cron schedule for automated thread member cleanup (default: every 6 hours)
THREAD_CLEANUP_SCHEDULE=0 */6 * * *

# Days of inactivity before a user is removed from a thread (only when ROLE_TO_THREAD=off)
THREAD_INACTIVITY_DAYS=30

# Comma-separated role IDs exempt from cleanup removal (separate from IGNORED_ROLES)
IGNORED_ROLES_CLEANUP=111111111111111111,222222222222222222

# ── Optional ─────────────────────────────────────────────────────────────────

# Comma-separated role IDs whose holders are exempt from all checks
IGNORED_ROLES=777777777777777777,888888888888888888

# Twitter/X URL substring to block (e.g. "twitter.com/myproject")
# If set, any message containing this string is deleted and the author warned
BOTANIX_TWITTER=twitter.com/myproject

# Channel ID where violation logs are sent (logging disabled if not set)
LOG_CHANNEL_ID=123456789012345679

# Rate limiting — max requests per cooldown window
RATE_LIMIT_MAX_REQUESTS=5
# Cooldown window duration in milliseconds
RATE_LIMIT_COOLDOWN=1000

# Minutes after which a deleted URL is considered "old" enough to repost (default: 60)
THRESHOLD_DUPE_AGE=60
```

### Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Bot authentication token |
| `MAIN_CHANNEL_ID` | ✅ | — | Forum channel to monitor |
| `AUTO_DELETE_TIMER` | | `30` | Seconds before bot reply is auto-deleted |
| `DB_TIMEOUT` | | `1` | Database operation timeout (minutes) |
| `URL_CHECK_TIMEOUT` | | `5000` | Delay before URL processing (ms) |
| `ROLE_0_ID` … `ROLE_5_ID` | ✅ when `ROLE_TO_THREAD=on` | — | Six role IDs for tier mapping |
| `THREAD_0_ID` … `THREAD_5_ID` | ✅ when `ROLE_TO_THREAD=on` | — | Six thread IDs corresponding to each role |
| `IGNORED_ROLES` | | — | Comma-separated role IDs to skip |
| `BOTANIX_TWITTER` | | — | Twitter URL pattern to block |
| `LOG_CHANNEL_ID` | | — | Channel for violation log embeds |
| `RATE_LIMIT_MAX_REQUESTS` | | `5` | Max requests per cooldown |
| `RATE_LIMIT_COOLDOWN` | | `1000` | Cooldown window in ms |
| `THRESHOLD_DUPE_AGE` | | `60` | Minutes before a deleted URL can be reposted |
| `ROLE_TO_THREAD` | | `on` | `on` = enforce role/thread routing and role-based cleanup; `off` = no routing, use time-based cleanup |
| `THREAD_CLEANUP_SCHEDULE` | | `0 */6 * * *` | Cron expression for scheduled cleanup |
| `THREAD_INACTIVITY_DAYS` | | `30` | Days of inactivity before removal (time-based mode only) |
| `IGNORED_ROLES_CLEANUP` | | — | Comma-separated role IDs never removed by cleanup |

---

## Running the Bot

```bash
npm start
```

This runs `node contentoor.js`. The bot will log its startup status and confirm which forum channel it is monitoring.

---

## Commands

All commands require the **Administrator** permission.

### `!fetch links <channel_id> [limit]`

Bulk-imports all URLs from the specified channel into the database.

| Argument | Required | Default | Description |
|---|---|---|---|
| `channel_id` | ✅ | — | The Discord channel ID to scan |
| `limit` | | `5000` | Maximum number of messages to fetch |

**Example:**
```
!fetch links 123456789012345678 1000
```

The bot replies with an embed summarising:
- Total URLs already in the database
- URLs found in the target channel
- New URLs added during this fetch
- Save success/failure status

### `!cleanup thread`

Immediately runs the thread cleanup on the current thread.

- Must be used inside a thread.
- Requires Administrator permission.
- When `ROLE_TO_THREAD=on`: only works in threads configured as `THREAD_n_ID`.
- When `ROLE_TO_THREAD=off`: works in any thread that is a child of `MAIN_CHANNEL_ID`.

---

## URL Duplicate Detection Logic

When a message containing a URL is posted in a monitored forum thread, the bot evaluates it against the following scenarios in order:

| # | Situation | Action |
|---|---|---|
| 1 | URL matches the configured `BOTANIX_TWITTER` pattern | Delete message, warn author |
| 2 | Same URL already posted by a **different** user | Notify poster, react 🚫, log violation |
| 3 | Same URL posted by the **same user** in a **different** thread | Notify poster, react 🚫, log violation |
| 4 | Same URL posted by the **same user** in the **same thread** (message still exists) | Notify poster, react ⭕, log violation |
| 5 | Same URL, same user, same thread — original **deleted** within `THRESHOLD_DUPE_AGE` minutes | Allow silently (treated as a new submission) |
| 6 | Same URL, same user, same thread — original **deleted** beyond `THRESHOLD_DUPE_AGE` minutes | Notify poster, react ⭕, log violation |
| 7 | URL not seen before | Store URL, continue |

---

## Architecture

```
contentoor.js          ← Discord client setup, event routing, role enforcement
    │
    ├── UrlTracker     ← Duplicate detection, bulk fetch, violation logging
    │       └── UrlStorage     ← JSON-file persistence (URL_DB_<id>.json)
    │
    ├── ThreadCleaner  ← Scheduled/manual thread member cleanup
    │       └── ActivityStore  ← JSON-file persistence (ACTIVITY_DB_<id>.json)
    │
    ├── config.js      ← Environment variable parsing & validation
    └── utils.js       ← Shared helpers (timestamp logger)
```

**Key design decisions:**

- **Event-driven** — Responds to `messageCreate` events; no polling
- **File-based storage** — Each monitored channel gets its own `URL_DB_<channelId>.json` file; no external database required
- **Caching** — Thread display names are cached for one hour and cleaned up every five minutes to reduce API calls
- **Rate limiting** — Per-user request throttling prevents abuse of URL submissions
- **Graceful shutdown** — SIGINT/SIGTERM handlers flush the database to disk before exiting

---

## Data Storage

URLs are persisted to a JSON file named `URL_DB_<channelId>.json` in the project root. Each file contains an object keyed by channel ID, holding an array of URL records:

```json
{
  "<channelId>": [
    {
      "url": "https://example.com/article",
      "userId": "123456789012345678",
      "author": "username",
      "messageId": "987654321098765432",
      "timestamp": 1700000000000,
      "threadId": "111111111111111111",
      "messageUrl": "https://discord.com/channels/.../...",
      "guildId": "222222222222222222"
    }
  ]
}
```

Activity data is persisted to `ACTIVITY_DB_<channelId>.json`:

```json
{
  "<threadId>": {
    "<userId>": 1700000000000
  }
}
```

These files are excluded from version control via `.gitignore`.

---

## Project Structure

```
contentor_modular2-forum_notif2/
├── contentoor.js       # Main bot entry point
├── urltracker.js       # URL tracking and duplicate detection
├── urlStore.js         # JSON file persistence layer
├── scheduler.js        # Thread cleanup scheduler (role-based or time-based)
├── activityStore.js    # Activity timestamp persistence layer
├── config.js           # Environment variable configuration
├── utils.js            # Utility helpers
├── package.json        # Project metadata and dependencies
└── .env                # Environment variables (create this yourself)
```
