/**
 * Terminal Relay — Live Streaming, Snapshots & Recordings
 *
 * Provides real-time terminal output streaming via WebSocket,
 * asciicast v2 recording, snapshot capture, and MinIO upload.
 */

import { mkdirSync, existsSync, unlinkSync, writeFileSync, appendFileSync, readFileSync } from "fs";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getDatabase, withRetry, logActivity } from "./db.js";
import type { TerminalSnapshot, RecordingMetadata } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STREAMS_DIR = "/tmp/gwa-streams";
const RECORDINGS_DIR = "/tmp/gwa-recordings";
const TMUX_SESSION = "gwa-work";
function getWsPort(): number {
  return parseInt(process.env.WS_PORT || "8080", 10);
}

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://minio.default.svc.cluster.local:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "gwa-recordings";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
const MINIO_REGION = process.env.MINIO_REGION || "us-east-1";

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

interface StreamState {
  sessionId: string;
  tmuxTarget: string;
  fifoPath: string;
  recordingPath: string;
  readerProc: ReturnType<typeof Bun.spawn> | null;
  startedAt: number;
}

/** Active streams keyed by sessionId */
const activeStreams = new Map<string, StreamState>();

/** Bun WebSocket server instance */
let wsServer: ReturnType<typeof Bun.serve> | null = null;

// ---------------------------------------------------------------------------
// S3 Client (lazy)
// ---------------------------------------------------------------------------

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: MINIO_REGION,
      credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }
  return s3Client;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

async function execTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

/**
 * Capture current pane content with ANSI escape codes.
 */
async function captureCurrentPane(tmuxTarget: string): Promise<string> {
  return execTmux(["capture-pane", "-e", "-p", "-t", tmuxTarget]);
}

// ---------------------------------------------------------------------------
// Asciicast v2 helpers
// ---------------------------------------------------------------------------

function writeAsciicastHeader(path: string, width = 200, height = 50): void {
  const header = JSON.stringify({
    version: 2,
    width,
    height,
    timestamp: Math.floor(Date.now() / 1000),
    env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
  });
  writeFileSync(path, header + "\n");
}

function appendAsciicastEvent(path: string, startedAt: number, data: string): void {
  const elapsed = (Date.now() - startedAt) / 1000;
  const event = JSON.stringify([elapsed, "o", data]);
  appendFileSync(path, event + "\n");
}

// ---------------------------------------------------------------------------
// FIFO streaming
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Start streaming pane output for a session.
 *
 * Creates a named pipe, attaches tmux pipe-pane to it, and spawns a reader
 * that broadcasts chunks to WebSocket subscribers and writes to an asciicast
 * recording file.
 */
export async function startPaneStream(
  sessionId: string,
  tmuxTarget: string
): Promise<void> {
  if (activeStreams.has(sessionId)) {
    throw new Error(`Stream already active for session ${sessionId}`);
  }

  ensureDir(STREAMS_DIR);
  ensureDir(RECORDINGS_DIR);

  const fifoPath = `${STREAMS_DIR}/${sessionId}.fifo`;
  const recordingPath = `${RECORDINGS_DIR}/${sessionId}.cast`;

  // Create FIFO
  if (existsSync(fifoPath)) {
    unlinkSync(fifoPath);
  }
  const mkfifoProc = Bun.spawn(["mkfifo", fifoPath], { stdout: "pipe", stderr: "pipe" });
  const mkfifoExit = await mkfifoProc.exited;
  if (mkfifoExit !== 0) {
    const stderr = await new Response(mkfifoProc.stderr).text();
    throw new Error(`mkfifo failed: ${stderr}`);
  }

  // Initialize asciicast recording
  writeAsciicastHeader(recordingPath);

  const startedAt = Date.now();

  // Attach tmux pipe-pane to push output to the FIFO
  await execTmux(["pipe-pane", "-t", tmuxTarget, `cat > ${fifoPath}`]);

  // Spawn reader process that tails the FIFO
  const readerProc = Bun.spawn(["cat", fifoPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const state: StreamState = {
    sessionId,
    tmuxTarget,
    fifoPath,
    recordingPath,
    readerProc,
    startedAt,
  };

  activeStreams.set(sessionId, state);

  // Read chunks in background
  (async () => {
    const reader = readerProc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });

        // Broadcast to WebSocket subscribers
        if (wsServer) {
          wsServer.publish(sessionId, text);
        }

        // Append to asciicast recording
        appendAsciicastEvent(recordingPath, startedAt, text);
      }
    } catch {
      // Stream closed, expected on stopPaneStream
    }
  })();

  logActivity(sessionId, "pane_stream_started", { tmuxTarget }, "system");
}

/**
 * Stop streaming pane output for a session.
 *
 * Detaches pipe-pane, closes the FIFO reader, removes the FIFO, and
 * uploads the recording to MinIO.
 */
export async function stopPaneStream(sessionId: string): Promise<RecordingMetadata | null> {
  const state = activeStreams.get(sessionId);
  if (!state) {
    return null;
  }

  // Detach tmux pipe-pane
  try {
    await execTmux(["pipe-pane", "-t", state.tmuxTarget]);
  } catch {
    // Pane may already be gone
  }

  // Kill reader process
  if (state.readerProc) {
    state.readerProc.kill();
  }

  // Clean up FIFO
  if (existsSync(state.fifoPath)) {
    unlinkSync(state.fifoPath);
  }

  activeStreams.delete(sessionId);

  // Upload recording to MinIO
  let metadata: RecordingMetadata | null = null;
  if (existsSync(state.recordingPath)) {
    try {
      metadata = await uploadRecording(sessionId, state.recordingPath, state.startedAt);
    } catch (error) {
      console.error(`[terminal-relay] Failed to upload recording for ${sessionId}:`, error);
    }

    // Clean up local recording file after upload attempt
    try {
      unlinkSync(state.recordingPath);
    } catch {
      // Ignore
    }
  }

  logActivity(sessionId, "pane_stream_stopped", { durationMs: Date.now() - state.startedAt }, "system");
  return metadata;
}

/**
 * Check whether a stream is active for a session.
 */
export function isStreamActive(sessionId: string): boolean {
  return activeStreams.has(sessionId);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Capture a terminal snapshot and store in SQLite.
 *
 * Attempts SVG conversion via ansi-to-svg; falls back to raw ANSI text.
 */
export async function takeSnapshot(
  sessionId: string,
  tmuxTarget: string,
  eventType: string
): Promise<TerminalSnapshot> {
  const ansiContent = await captureCurrentPane(tmuxTarget);

  let svgData: string;
  try {
    // Dynamic import to handle potential Bun incompatibility
    const ansiToSVG = (await import("ansi-to-svg")).default;
    svgData = ansiToSVG(ansiContent, {
      paddingTop: 10,
      paddingLeft: 10,
      paddingBottom: 10,
      paddingRight: 10,
      colors: "monokai",
    });
  } catch {
    // Fallback: store raw ANSI text
    svgData = ansiContent;
  }

  const capturedAt = Math.floor(Date.now() / 1000);

  const db = getDatabase();
  withRetry(() => {
    db.run(
      `INSERT INTO terminal_snapshots (session_id, svg_data, event_type, captured_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, svgData, eventType, capturedAt]
    );
  });

  logActivity(sessionId, "terminal_snapshot_captured", { eventType }, "system");

  return { sessionId, svgData, eventType, capturedAt };
}

/**
 * Get all snapshots for a session.
 */
export function getSessionSnapshots(sessionId: string): TerminalSnapshot[] {
  const db = getDatabase();
  const rows = db
    .query(`SELECT session_id, svg_data, event_type, captured_at FROM terminal_snapshots WHERE session_id = ? ORDER BY captured_at`)
    .all(sessionId) as Array<{ session_id: string; svg_data: string; event_type: string; captured_at: number }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    svgData: r.svg_data,
    eventType: r.event_type,
    capturedAt: r.captured_at,
  }));
}

// ---------------------------------------------------------------------------
// MinIO / S3 upload
// ---------------------------------------------------------------------------

async function uploadRecording(
  sessionId: string,
  localPath: string,
  startedAt: number
): Promise<RecordingMetadata> {
  const fileData = readFileSync(localPath);
  const timestamp = Math.floor(Date.now() / 1000);
  const s3Key = `recordings/${sessionId}/${timestamp}.cast`;

  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: s3Key,
      Body: fileData,
      ContentType: "application/x-asciicast",
    })
  );

  const metadata: RecordingMetadata = {
    sessionId,
    s3Key,
    durationMs: Date.now() - startedAt,
    sizeBytes: fileData.length,
    format: "asciicast-v2",
    uploadedAt: timestamp,
  };

  // Store metadata in activity log
  logActivity(sessionId, "recording_uploaded", {
    s3Key,
    sizeBytes: fileData.length,
    durationMs: metadata.durationMs,
  }, "system");

  return metadata;
}

/**
 * Get a presigned URL for a recording (expires in 1 hour).
 */
export async function getPresignedUrl(s3Key: string): Promise<string> {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: MINIO_BUCKET,
    Key: s3Key,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

/**
 * Start the WebSocket relay server on the configured port.
 *
 * Each client subscribes to a topic matching the sessionId.
 * On connect, the current pane content is sent as the first message
 * (mid-stream join).
 */
export function startWebSocketServer(port?: number): ReturnType<typeof Bun.serve> {
  if (wsServer) {
    return wsServer;
  }

  const wsPort = port ?? getWsPort();

  wsServer = Bun.serve({
    port: wsPort,
    fetch(req, server) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // WebSocket upgrade: /ws/{sessionId}
      const match = url.pathname.match(/^\/ws\/(.+)$/);
      if (!match) {
        return new Response("Not found", { status: 404 });
      }

      const sessionId = match[1];
      const upgraded = server.upgrade(req, { data: { sessionId } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      // Bun handles the response after upgrade
      return undefined as unknown as Response;
    },
    websocket: {
      open(ws) {
        const { sessionId } = ws.data as { sessionId: string };
        ws.subscribe(sessionId);

        // Mid-stream join: send current pane content
        const state = activeStreams.get(sessionId);
        if (state) {
          captureCurrentPane(state.tmuxTarget)
            .then((content) => {
              ws.send(content);
            })
            .catch(() => {
              // Pane may not exist
            });
        }
      },
      message(_ws, _message) {
        // Clients are read-only; ignore incoming messages
      },
      close(ws) {
        const { sessionId } = ws.data as { sessionId: string };
        ws.unsubscribe(sessionId);
      },
    },
  });

  console.log(`[terminal-relay] WebSocket server listening on port ${wsPort}`);
  return wsServer;
}

/**
 * Stop the WebSocket server.
 */
export function stopWebSocketServer(): void {
  if (wsServer) {
    wsServer.stop(true); // Force-close all connections immediately
    wsServer = null;
  }
}

/**
 * Shut down all active streams and the WebSocket server.
 */
export async function shutdown(): Promise<void> {
  // Stop all active streams
  const sessions = Array.from(activeStreams.keys());
  for (const sessionId of sessions) {
    await stopPaneStream(sessionId);
  }

  stopWebSocketServer();
}
