# Promptboard's Docker sandbox for card agents (docs/docker-sandbox.md). Built from Settings → Docker sandbox,
# with the Claude Code and Codex versions installed on this computer; an empty version skips that CLI.
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=
ARG CODEX_VERSION=
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then npm install -g "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"; fi \
 && if [ -n "$CODEX_VERSION" ]; then npm install -g "@openai/codex@$CODEX_VERSION"; fi \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*
# The image's CLIs are replaced by building a new image, never updated in place by the running user.
ENV DISABLE_AUTOUPDATER=1
