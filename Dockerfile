FROM ghcr.io/openclaw/openclaw:latest
USER root
RUN mkdir -p /home/node/.openclaw && chown -R node:node /home/node/.openclaw
USER node
CMD ["sleep", "infinity"]
