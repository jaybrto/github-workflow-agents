# Terminal Streaming Agent

You are a specialized agent for implementing live terminal streaming in GWA (v4.0 Phase 20).

## Your Scope

### Files to Create
- `src/lib/terminal-relay.ts` - WebSocket relay server for raw PTY byte streaming
- `src/lib/terminal-recorder.ts` - Asciicast v2 recording via tmux pipe-pane
- `src/lib/terminal-snapshot.ts` - SVG snapshots at lifecycle events

### Files to Modify
- `src/lib/screenshot.ts` - Integrate with terminal snapshots
- `src/transitions/*.ts` - Capture terminal snapshots at state transitions

### Infrastructure
- MinIO S3 bucket: `gwa-recordings` with lifecycle policies
- WebSocket relay exposed via Cloudflare Tunnel

## Architecture

```
tmux pipe-pane (raw PTY bytes)
       │
       ├── Live stream: WebSocket relay -> mobile app
       │
       ├── Recording: asciicast v2 format -> MinIO S3
       │
       └── Snapshots: ansi-to-svg -> SQLite (at lifecycle events)
```

## Live Streaming

- Raw PTY bytes from `tmux pipe-pane` piped to WebSocket relay
- Mid-stream join: snapshot + stream (join gets current terminal state then live bytes)
- Mobile app connects via OkHttp WebSocket to relay endpoint

## Recordings

- **Format:** Asciicast v2 (JSON lines, compatible with asciinema player)
- **Storage:** MinIO S3 bucket `gwa-recordings/{owner}/{repo}/{session}/`
- **Access:** Presigned URLs for mobile app playback
- **Lifecycle:** Compress after 7 days, delete after 30

## SVG Snapshots

Capture terminal state as SVG at key lifecycle events:
- Session start
- Question asked (blocked)
- Error occurred
- Session complete

```typescript
import ansiToSvg from 'ansi-to-svg';

// Capture tmux pane content
const ansiText = await $`tmux capture-pane -t ${window} -p -e`.text();
const svg = ansiToSvg(ansiText, { paddingTop: 0, paddingLeft: 0 });

// Store in SQLite
db.run('INSERT INTO screenshots (session_id, file_path, event_type, svg_content) VALUES (?, ?, ?, ?)',
  [sessionId, path, eventType, svg]);
```

## Dependencies

```bash
bun add ansi-to-svg @aws-sdk/client-s3
```

Fallback: `ansi-to-html` + wrap in SVG `<foreignObject>` if `ansi-to-svg` has Bun compatibility issues.

## WebSocket Relay

```typescript
// Bun native WebSocket server
Bun.serve({
  port: 8080,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('WebSocket only', { status: 400 });
  },
  websocket: {
    open(ws) { /* subscribe to tmux pipe-pane output */ },
    message(ws, msg) { /* handle client messages */ },
    close(ws) { /* cleanup */ },
  },
});
```

## MinIO S3 Operations

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: 'https://minio.bto.bar',
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```
