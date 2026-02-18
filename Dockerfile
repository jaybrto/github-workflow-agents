# Stage 1: Build Bun CLI tools into standalone binaries
FROM oven/bun:1-debian AS builder

WORKDIR /build

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json ./
COPY src/ src/
COPY schema.sql ./

# Build all CLI tools as standalone executables
RUN mkdir -p dist && \
    bun build src/orchestrate.ts --compile --outfile dist/gwa-orchestrate && \
    bun build src/respond.ts --compile --outfile dist/gwa-respond && \
    bun build src/cleanup.ts --compile --outfile dist/gwa-cleanup && \
    bun build src/health-check.ts --compile --outfile dist/gwa-health-check && \
    bun build src/ask-question.ts --compile --outfile dist/gwa-ask-question && \
    bun build src/session-complete.ts --compile --outfile dist/gwa-session-complete && \
    bun build src/architect.ts --compile --outfile dist/gwa-architect && \
    bun build src/worker.ts --compile --outfile dist/gwa-worker && \
    bun build src/setup-project.ts --compile --outfile dist/gwa-setup-project && \
    bun build src/transitions/start-planning.ts --compile --outfile dist/gwa-start-planning && \
    bun build src/transitions/inject-prompt.ts --compile --outfile dist/gwa-inject-prompt && \
    bun build src/transitions/run-playwright.ts --compile --outfile dist/gwa-run-playwright && \
    bun build src/transitions/resume-with-failures.ts --compile --outfile dist/gwa-resume-with-failures && \
    bun build src/transitions/send-answer.ts --compile --outfile dist/gwa-send-answer && \
    bun build src/transitions/deploy-and-cleanup.ts --compile --outfile dist/gwa-deploy-and-cleanup

# Stage 2: Runtime image with Node.js (for Claude Code) + compiled Bun tools
FROM node:22-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    sqlite3 \
    git \
    curl \
    jq \
    watch \
    ca-certificates \
    gnupg \
    aha \
    wkhtmltopdf \
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
COPY --from=builder /build/dist/gwa-health-check /usr/local/bin/
COPY --from=builder /build/dist/gwa-ask-question /usr/local/bin/
COPY --from=builder /build/dist/gwa-session-complete /usr/local/bin/
COPY --from=builder /build/dist/gwa-architect /usr/local/bin/
COPY --from=builder /build/dist/gwa-worker /usr/local/bin/
COPY --from=builder /build/dist/gwa-setup-project /usr/local/bin/
COPY --from=builder /build/dist/gwa-start-planning /usr/local/bin/
COPY --from=builder /build/dist/gwa-inject-prompt /usr/local/bin/
COPY --from=builder /build/dist/gwa-run-playwright /usr/local/bin/
COPY --from=builder /build/dist/gwa-resume-with-failures /usr/local/bin/
COPY --from=builder /build/dist/gwa-send-answer /usr/local/bin/
COPY --from=builder /build/dist/gwa-deploy-and-cleanup /usr/local/bin/
RUN chmod +x /usr/local/bin/gwa-*

# Copy SQLite schema to a location outside PVC mounts
# This ensures the schema survives volume mounts and can be used as source
RUN mkdir -p /opt/gwa
COPY --from=builder /build/schema.sql /opt/gwa/schema.sql

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
