#!/bin/bash
# BootstrapClaw startup script

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

# Pull latest code from GitHub
echo "[startup] Pulling latest bootstrapclaw-core.js from GitHub..."
curl -s -o /root/bootstrapclaw/bootstrapclaw-core.js \
  https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/chat-server.js \
  && echo "[startup] Pull OK" || echo "[startup] Pull failed, using cached version"

# Kill any existing instances before starting
pkill -f bootstrapclaw-core.js 2>/dev/null
sleep 2

# Start pipeline
node /root/bootstrapclaw/bootstrapclaw-core.js >> /root/bootstrapclaw/data/core.log 2>&1 &
echo "[startup] Pipeline PID: $!"

# Start chat server
node /root/bootstrapclaw/chat-server.js >> /root/bootstrapclaw/data/chat.log 2>&1 &
echo "[startup] Chat server PID: $!"

# Keep container alive
wait
