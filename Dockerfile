FROM ghcr.io/openclaw/openclaw:2026.3.13
USER root
ENV HOME=/root
WORKDIR /root
RUN apt-get update && apt-get install -y jq && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
