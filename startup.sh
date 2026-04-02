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

# Start
node /root/bootstrapclaw/bootstrapclaw-core.js >> /root/bootstrapclaw/data/core.log 2>&1 &
echo "[startup] Started PID: $!"

# Keep container alive
wait
