ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install system deps
RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    nodejs \
    npm \
    util-linux \
    ca-certificates \
    tzdata \
    unzip

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Install Bun (required for Claude Code Channels plugins)
# Install to /opt/bun so it's available regardless of HOME at runtime
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
ENV PATH="/opt/bun/bin:${PATH}"

# Install xterm.js browser assets for the web terminal (served from add-on to avoid CSP issues)
RUN npm install --prefix /tmp/xterm @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 --save=false && \
    mkdir -p /app/assets && \
    cp /tmp/xterm/node_modules/@xterm/xterm/lib/xterm.js         /app/assets/ && \
    cp /tmp/xterm/node_modules/@xterm/xterm/css/xterm.css        /app/assets/ && \
    cp /tmp/xterm/node_modules/@xterm/addon-fit/lib/addon-fit.js /app/assets/ && \
    rm -rf /tmp/xterm

# Install terminal server Node.js dependencies.
# node-pty requires native compilation — build tools are removed after.
COPY app/package.json /app/package.json
RUN apk add --no-cache --virtual .node-build python3 make g++ linux-headers && \
    cd /app && npm install --omit=dev && \
    apk del .node-build

# Install Claude Code via official installer
# The installer places the binary at /root/.local/bin/claude
# Use bash explicitly — Alpine's /bin/sh (busybox ash) doesn't support the installer syntax
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# Verify Claude Code version supports Channels (requires >=2.1.80)
RUN CLAUDE_VERSION=$(claude --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) && \
    [ -n "$CLAUDE_VERSION" ] || { echo "ERROR: could not determine Claude Code version"; exit 1; } && \
    echo "Claude Code version: ${CLAUDE_VERSION}" && \
    MAJOR=$(echo "$CLAUDE_VERSION" | cut -d. -f1) && \
    MINOR=$(echo "$CLAUDE_VERSION" | cut -d. -f2) && \
    PATCH=$(echo "$CLAUDE_VERSION" | cut -d. -f3) && \
    if [ "$MAJOR" -lt 2 ] || \
       ([ "$MAJOR" -eq 2 ] && [ "$MINOR" -lt 1 ]) || \
       ([ "$MAJOR" -eq 2 ] && [ "$MINOR" -eq 1 ] && [ "$PATCH" -lt 80 ]); then \
      echo "ERROR: Claude Code ${CLAUDE_VERSION} is too old. Channels require >=2.1.80"; exit 1; \
    fi

# Point Claude config to the persistent volume at runtime
# /data is the add-on's persistent volume (mounted by Supervisor)
ENV CLAUDE_CONFIG_DIR="/data/.claude"

# Copy rootfs overlay (s6 services, init scripts)
COPY rootfs /

# Copy app scripts
COPY app /app

# Custom integration deployed into the user's HA config by 30-deploy-integration.sh
COPY custom_components /app/custom_components

RUN chmod +x \
    /etc/cont-init.d/10-setup.sh \
    /etc/cont-init.d/20-mcp-assist.sh \
    /etc/cont-init.d/30-deploy-integration.sh \
    /etc/services.d/claude/run \
    /etc/services.d/claude/finish \
    /etc/services.d/ttyd/run \
    /etc/services.d/ttyd/finish \
    /etc/services.d/prompt-api/run \
    /etc/services.d/prompt-api/finish \
    /app/start.sh \
    /app/claude-daemon.js \
    /app/prompt-api.js

WORKDIR /root
