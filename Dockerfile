FROM ghcr.io/openclaw/openclaw:2026.3.11
USER root
ENV HOME=/root
WORKDIR /root

RUN apt-get update && apt-get install -y jq && rm -rf /var/lib/apt/lists/*

# Create bootstrapclaw directory structure
RUN mkdir -p /root/bootstrapclaw/scripts \
             /root/bootstrapclaw/PROMPTS \
             /root/bootstrapclaw/data/drafts

# Copy core files
COPY bootstrapclaw-core.js /root/bootstrapclaw/bootstrapclaw-core.js
COPY startup.sh /root/bootstrapclaw/startup.sh
COPY scripts/devto-publish.js /root/bootstrapclaw/scripts/devto-publish.js
COPY scripts/get-cover.js /root/bootstrapclaw/scripts/get-cover.js
COPY scripts/tg-notify.js /root/bootstrapclaw/scripts/tg-notify.js
RUN chmod +x /root/bootstrapclaw/startup.sh

# Symlink data dir to persistent volume so runs.log survives redeploys
# Actual symlink created at runtime in startup.sh (volume not mounted at build time)

CMD ["/root/bootstrapclaw/startup.sh"]
