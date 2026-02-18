/**
 * Canonical shared types for GWA v4.0
 *
 * All modules import from here for consistent type definitions.
 */

// Session states matching GitHub Project columns
export enum SessionState {
  Idle = 'idle',
  Planning = 'planning',
  InProgress = 'in_progress',
  QA = 'qa',
  Blocked = 'blocked',
  Review = 'review',
  Done = 'done',
}

// XState events - all valid transitions
export type SessionEvent =
  | { type: 'START_PLANNING' }
  | { type: 'INJECT_PROMPT' }
  | { type: 'RUN_TESTS' }
  | { type: 'STATUS_UPDATE' }
  | { type: 'DEPLOY_AND_CLEANUP' }
  | { type: 'PAUSE_FOR_QUESTION' }
  | { type: 'SEND_ANSWER' }
  | { type: 'RESUME_WITH_FAILURES' }
  | { type: 'REQUEST_RETEST' }
  | { type: 'REQUEST_REPLANNING' }
  | { type: 'RESUME_IMPLEMENTATION' }
  | { type: 'CANCEL_SESSION' }
  | { type: 'REOPEN_ISSUE' }
  | { type: 'QUICK_START' }
  | { type: 'CLOSE_WITHOUT_WORK' }
  | { type: 'SKIP_QA' }
  | { type: 'SKIP_IMPLEMENTATION' };

// AMQP message envelope
export interface AmqpMessage {
  routingKey: string;
  payload: Record<string, unknown>;
  timestamp: number;
  sessionId: string;
  traceId?: string;
}

// Push notification for ntfy.sh
export interface PushNotification {
  type: 'blocked' | 'error' | 'complete' | 'info';
  title: string;
  body: string;
  sessionId: string;
  priority: 1 | 2 | 3 | 4 | 5; // ntfy priority levels
  tags?: string[];
}

// Terminal snapshot stored in SQLite
export interface TerminalSnapshot {
  sessionId: string;
  svgData: string;
  eventType: string;
  capturedAt: number;
}

// Recording metadata for MinIO/S3
export interface RecordingMetadata {
  sessionId: string;
  s3Key: string;
  durationMs: number;
  sizeBytes: number;
  format: 'asciicast-v2';
  uploadedAt: number;
}

// Column transition from webhook
export interface ColumnTransition {
  from: string;
  to: string;
  itemId: string;
  projectId: string;
  contentId?: string;
  contentType?: string;
}

// XState machine context
export interface SessionContext {
  sessionId: string;
  previousState: SessionState | null;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  prNumber?: number;
  worktreePath?: string;
  tmuxWindow?: string;
}
