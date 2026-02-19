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
  type: 'blocked' | 'error' | 'complete' | 'info' | 'auth_expiring' | 'auth_refresh_failed';
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

// ---------------------------------------------------------------------------
// Environment provisioning types
// ---------------------------------------------------------------------------

/** Project configuration stored in orchestrator DB */
export interface ProjectConfig {
  id: string;
  displayName: string;
  claudeAccountUuid?: string;
  claudeOrgUuid?: string;
  claudeEmail?: string;
  settingsJson?: string;
  claudeJson?: string;
  mcpJson?: string;
  claudeMd?: string;
  createdAt: number;
  updatedAt: number;
}

/** Credential row in orchestrator DB */
export interface ProjectCredential {
  id: string;
  projectId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  billingType: string;
  displayName: string;
  source: 'push' | 'refresh' | 'import';
  pushedBy?: string;
  createdAt: number;
  invalidatedAt?: number;
}

/** Environment bundle metadata stored in orchestrator DB */
export interface EnvironmentBundle {
  id: string;
  projectId: string;
  credentialId: string;
  version: number;
  s3Key: string;
  s3Bucket: string;
  sizeBytes?: number;
  configHash: string;
  credentialExpiresAt: number;
  createdAt: number;
  expiredAt?: number;
  cleanedUpAt?: number;
}

/** Request body for POST /projects/:id/provision */
export interface ProvisionRequest {
  podName: string;
  currentBundleId?: string;
}

/** Response from POST /projects/:id/provision */
export interface ProvisionResponse {
  status: 'current' | 'provisioned' | 'no_credentials';
  bundleId?: string;
  s3Key?: string;
  s3Bucket?: string;
  credentialExpiresAt?: number;
  message?: string;
}

/** Request body for POST /projects/:id/credentials */
export interface CredentialPushRequest {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  billingType?: string;
  displayName?: string;
}

/** Credential health status for GET /projects/:id/health */
export interface CredentialHealth {
  projectId: string;
  hasValidCredential: boolean;
  expiresAt?: number;
  expiresInMs?: number;
  hasRefreshToken: boolean;
  lastRefreshAt?: number;
  activeBundleId?: string;
}
