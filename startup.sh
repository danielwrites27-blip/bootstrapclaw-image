#!/bin/bash
# BootstrapClaw startup script

# GUARD: Don't start if already running
if pgrep -f bootstrapclaw-core.js > /dev/null 2>&1; then
  echo "[startup] Already running, skipping"
  wait
  exit 0
fi

# Symlink data dir to persistent volume
mkdir -p /root/.openclaw/bootstrapclaw-data/drafts
if [ ! -L /root/bootstrapclaw/data ]; then
  rm -rf /root/bootstrapclaw/data
  ln -sf /root/.openclaw/bootstrapclaw-data /root/bootstrapclaw/data
  echo "[startup] Data dir linked to persistent volume"
fi

# Clear stale drafts
rm -f /root/bootstrapclaw/data/drafts/research.json
rm -f /root/bootstrapclaw/data/drafts/article.json
rm -f /root/bootstrapclaw/data/drafts/article-publish.json

# Pull latest code from GitHub (30s timeout)
echo "[startup] Pulling latest code from GitHub..."
curl -s --max-time 30 -o /root/bootstrapclaw/bootstrapclaw-core.js https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/bootstrapclaw-core.js || echo "[startup] Pull failed - using cached bootstrapclaw-core.js"
curl -s --max-time 30 -o /root/bootstrapclaw/chat-server.js https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/chat-server.js || echo "[startup] Pull failed - using cached chat-server.js"
curl -s --max-time 30 -o /root/bootstrapclaw/agent-chat.js https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/agent-chat.js || echo "[startup] Pull failed - using cached agent-chat.js"
curl -s --max-time 30 -H "Authorization: token $GITHUB_TOKEN" -o /root/bootstrapclaw/package.json https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/package.json || echo "[startup] Pull failed - using cached package.json"
cd /root/bootstrapclaw && npm install --silent
echo "[startup] Pull complete"

# Start pipeline
node /root/bootstrapclaw/bootstrapclaw-core.js >> /root/bootstrapclaw/data/core.log 2>&1 &
echo "[startup] Pipeline PID: $!"

# Start chat server
node /root/bootstrapclaw/chat-server.js >> /root/bootstrapclaw/data/chat.log 2>&1 &
echo "[startup] Chat server PID: $!"

# Start agent
node /root/bootstrapclaw/agent-chat.js >> /root/bootstrapclaw/data/agent.log 2>&1 &
echo "[startup] Agent PID: $!"

wait
