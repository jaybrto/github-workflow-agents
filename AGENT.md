# AGENT.md

## Project Overview
This repository contains "github-workflow-agents", a system to manage AI agents using persistent repository sessions on Kubernetes with tmux and persisted pods. It orchestrates agents via GitHub projects and issues.

## Tech Stack
- **Runtime:** Bun
- **Language:** TypeScript
- **Containerization:** Docker, Kubernetes
- **State Management:** Redis
- **Session Management:** Tmux
- **APIs:** GitHub Octokit, Kubernetes Client

## Directory Structure
- `src/`: Source code
  - `orchestrate.ts`: Entry point for orchestration logic.
  - `respond.ts`: Entry point for response logic.
  - `cleanup.ts`: Cleanup utility.
  - `debug-redis.ts`: Redis debugging utility.
  - `health-check.ts`: Health check utility.
  - `lib/`: Shared libraries (Claude, Git, GitHub, Redis, Tmux).
- `k8s/`: Kubernetes configuration.
- `scripts/`: Helper scripts.

## Development

### Dependencies
Install dependencies using Bun:
```bash
bun install
```

### Building
The project uses Bun for building binaries. See `package.json` for scripts:
```bash
bun run build
```
Individual components can be built using:
- `bun run build:orchestrate`
- `bun run build:respond`
- `bun run build:cleanup`
- `bun run build:debug-redis`
- `bun run build:health-check`

### Testing
Run tests using Bun's test runner:
```bash
bun test
```

## Coding Conventions
- **TypeScript:** Use strict typing where possible.
- **Async/Await:** Use async/await for asynchronous operations.
- **Formatting:** Follow the existing coding style (implied by lack of explicit linter config, but consistency is key).
- **Error Handling:** Ensure robust error handling, especially for external API calls (GitHub, K8s, Redis).

## Architecture Notes
- The system uses Kubernetes pods to maintain persistent sessions.
- Tmux is used within pods to manage shell sessions.
- Redis is likely used for coordination or state persistence between the orchestration and response components.
