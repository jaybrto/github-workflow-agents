export interface PRContext {
  pr: number;
  repo: string;
  owner: string;
  repoName: string;
  branch?: string;
  trigger: "pr_event" | "comment" | "manual";
  comment?: string;
  actor: string;
  mode?: "repl" | "headless";
}

export interface PRSession {
  tmuxWindow: number;
  podName: string;
  worktreePath: string;
  createdAt: number;
  lastActivity: number;
  status: "active" | "waiting" | "completed" | "error";
}

export interface PRQuestion {
  question: string;
  askedAt: number;
  answer?: string;
  answeredAt?: number;
  answeredBy?: string;
}

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  result?: unknown;
  error?: string;
}

export interface OrchestrateArgs {
  pr: number;
  repo: string;
  trigger: "pr_event" | "comment" | "manual";
  branch?: string;
  comment?: string;
  actor: string;
  mode?: "repl" | "headless";
}

export interface RespondArgs {
  pr: number;
  repo: string;
  comment: string;
  actor: string;
}

export interface CleanupArgs {
  repo: string;
  pod: string;
  dryRun?: boolean;
}
