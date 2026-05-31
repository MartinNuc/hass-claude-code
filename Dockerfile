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
    python3 \
    ca-certificates \
    tzdata \
    unzip

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Install Bun (required for Claude Code Channels plugins)
# Install to /opt/bun so it's available regardless of HOME at runtime
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
ENV PATH="/opt/bun/bin:${PATH}"

# Install uv (Python package manager — needed for hass-mcp which requires Python >=3.13)
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/opt/uv sh
ENV PATH="/opt/uv/bin:${PATH}"

# Install hass-mcp (Home Assistant MCP server)
# Uses uv to pull Python >=3.13 and install hass-mcp in an isolated environment
RUN UV_TOOL_BIN_DIR=/root/.local/bin uv tool install hass-mcp
ENV PATH="/root/.local/bin:${PATH}"

# Install Claude Code via official installer
# The installer places the binary at /root/.local/bin/claude
RUN curl -fsSL https://claude.ai/install.sh | sh

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

RUN chmod +x \
    /etc/cont-init.d/10-setup.sh \
    /etc/services.d/claude/run \
    /etc/services.d/claude/finish \
    /app/start.sh

WORKDIR /root
