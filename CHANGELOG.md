# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-11

### Added

- Initial release with PR orchestration, respond, cleanup, and webhook handler
- Tmux session management for persistent Claude Code sessions
- Redis-based PR-to-session tracking
- OpenTelemetry instrumentation (traces, metrics, logs) via Grafana LGTM stack
- GitHub Projects v2 integration with custom fields
- Kubernetes pod lifecycle management
- Playwright screenshot capture and lifecycle tracking
- Sub-agent spawning with status tracking
