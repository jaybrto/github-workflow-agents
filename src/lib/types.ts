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

// PRSession and PRQuestion types have been removed.
// Session and Question data is now managed via SQLite in src/lib/db.ts.

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
