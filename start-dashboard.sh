#!/bin/bash
cd "$(dirname "$0")"
echo "Starting voting dashboard..."
node dashboard/server.js
