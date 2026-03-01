FROM ghcr.io/openclaw/openclaw:latest
USER root
ENV HOME=/root
WORKDIR /root
CMD ["sleep", "infinity"]
