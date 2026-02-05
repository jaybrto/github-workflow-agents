# Stage 1: Build Bun CLI tools into standalone binaries
FROM oven/bun:1-debian AS builder

WORKDIR /build

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json ./
COPY src/ src/

# Build all CLI tools as standalone executables
RUN mkdir -p dist && \
    bun build src/orchestrate.ts --compile --outfile dist/gwa-orchestrate && \
    bun build src/respond.ts --compile --outfile dist/gwa-respond && \
    bun build src/cleanup.ts --compile --outfile dist/gwa-cleanup && \
    bun build src/debug-redis.ts --compile --outfile dist/gwa-debug-redis && \
    bun build src/health-check.ts --compile --outfile dist/gwa-health-check

# Stage 2: Runtime image with Node.js (for Claude Code) + compiled Bun tools
FROM node:22-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    redis-tools \
    git \
    curl \
    jq \
    watch \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) \
      signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code && \
    npm cache clean --force

# Copy compiled Bun CLI tools from builder
COPY --from=builder /build/dist/gwa-orchestrate /usr/local/bin/
COPY --from=builder /build/dist/gwa-respond /usr/local/bin/
COPY --from=builder /build/dist/gwa-cleanup /usr/local/bin/
COPY --from=builder /build/dist/gwa-debug-redis /usr/local/bin/
COPY --from=builder /build/dist/gwa-health-check /usr/local/bin/
RUN chmod +x /usr/local/bin/gwa-*

# Create runner user and directories
RUN useradd -m -d /home/runner -s /bin/bash runner && \
    mkdir -p /home/runner/.claude \
             /home/runner/.config/gh \
             /home/runner/worktrees \
             /home/runner/repo && \
    chown -R runner:runner /home/runner

USER runner
WORKDIR /home/runner

ENTRYPOINT ["tail", "-f", "/dev/null"]
