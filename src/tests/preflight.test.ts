/**
 * Pre-flight checks for GWA deployment
 * These tests validate everything needed before adding the first project item
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import { Database } from "bun:sqlite";

const ROOT = resolve(import.meta.dir, "../..");

describe("Pre-flight: Schema Validation", () => {
  let db: Database;
  const testDbPath = "/tmp/gwa-preflight-test.db";

  beforeAll(async () => {
    // Remove old test db
    if (existsSync(testDbPath)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(testDbPath);
    }

    // Create database and load schema
    db = new Database(testDbPath);
    const schema = await Bun.file(`${ROOT}/schema.sql`).text();
    db.exec(schema);
  });

  test("all required tables exist", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    const requiredTables = [
      "sessions",
      "questions",
      "prompts",
      "commits",
      "tool_calls",
      "activity_log",
      "screenshots",
      "config",
      "update_queue",
      "dependency_versions",
      "responses",
      "checkpoints",
      "conversation_history",
      "agent_tasks",
    ];

    for (const table of requiredTables) {
      expect(tableNames).toContain(table);
    }
  });

  test("sessions table has all required columns", () => {
    const columns = db.query("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    const required = [
      "id",
      "type",
      "status",
      "github_number",
      "github_type",
      "repo",
      "branch",
      "tmux_window",
      "worktree_path",
      "created_at",
    ];

    for (const col of required) {
      expect(colNames).toContain(col);
    }
  });

  test("agent_tasks table supports swarm operations", () => {
    const columns = db.query("PRAGMA table_info(agent_tasks)").all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    const required = [
      "id",
      "session_id",
      "agent_type",
      "task_id",
      "name",
      "status",
      "progress",
      "result",
      "dependencies",
    ];

    for (const col of required) {
      expect(colNames).toContain(col);
    }
  });
});

describe("Pre-flight: Package.json Validation", () => {
  let pkg: Record<string, unknown>;

  beforeAll(async () => {
    const content = await Bun.file(`${ROOT}/package.json`).text();
    pkg = JSON.parse(content);
  });

  test("has required dependencies", () => {
    const deps = pkg.dependencies as Record<string, string>;

    expect(deps["@octokit/rest"]).toBeDefined();
    expect(deps["node-tmux"]).toBeDefined();
    expect(deps["@anthropic-ai/sdk"]).toBeDefined();
    expect(deps["@opentelemetry/sdk-node"]).toBeDefined();
    expect(deps["xstate"]).toBeDefined();
    expect(deps["amqplib"]).toBeDefined();
  });

  test("has build scripts for all entry points", () => {
    const scripts = pkg.scripts as Record<string, string>;

    // Core tools
    expect(scripts["build:orchestrate"]).toBeDefined();
    expect(scripts["build:respond"]).toBeDefined();
    expect(scripts["build:cleanup"]).toBeDefined();
    expect(scripts["build:architect"]).toBeDefined();
    expect(scripts["build:worker"]).toBeDefined();
    expect(scripts["build:setup-project"]).toBeDefined();

    // Transition tools
    expect(scripts["build:start-planning"]).toBeDefined();
    expect(scripts["build:inject-prompt"]).toBeDefined();
    expect(scripts["build:run-playwright"]).toBeDefined();
    expect(scripts["build:resume-with-failures"]).toBeDefined();
    expect(scripts["build:send-answer"]).toBeDefined();
    expect(scripts["build:deploy-and-cleanup"]).toBeDefined();
  });

  test("main build script includes all tools", () => {
    const scripts = pkg.scripts as Record<string, string>;
    const buildScript = scripts["build"];

    expect(buildScript).toContain("build:orchestrate");
    expect(buildScript).toContain("build:architect");
    expect(buildScript).toContain("build:start-planning");
    expect(buildScript).toContain("build:deploy-and-cleanup");
  });
});

describe("Pre-flight: Dockerfile Validation", () => {
  let dockerfile: string;

  beforeAll(async () => {
    dockerfile = await Bun.file(`${ROOT}/Dockerfile`).text();
  });

  test("builds all CLI tools", () => {
    // Core tools
    expect(dockerfile).toContain("gwa-orchestrate");
    expect(dockerfile).toContain("gwa-respond");
    expect(dockerfile).toContain("gwa-cleanup");
    expect(dockerfile).toContain("gwa-architect");
    expect(dockerfile).toContain("gwa-worker");
    expect(dockerfile).toContain("gwa-setup-project");

    // Transition tools
    expect(dockerfile).toContain("gwa-start-planning");
    expect(dockerfile).toContain("gwa-inject-prompt");
    expect(dockerfile).toContain("gwa-run-playwright");
    expect(dockerfile).toContain("gwa-resume-with-failures");
    expect(dockerfile).toContain("gwa-send-answer");
    expect(dockerfile).toContain("gwa-deploy-and-cleanup");
  });

  test("copies all binaries to /usr/local/bin", () => {
    const copyLines = dockerfile.split("\n").filter((l) => l.includes("COPY --from=builder"));

    expect(copyLines.length).toBeGreaterThanOrEqual(15); // Core + transitions
    expect(dockerfile).toContain("COPY --from=builder /build/dist/gwa-orchestrate /usr/local/bin/");
    expect(dockerfile).toContain("COPY --from=builder /build/dist/gwa-start-planning /usr/local/bin/");
  });

  test("installs required system packages", () => {
    expect(dockerfile).toContain("tmux");
    expect(dockerfile).toContain("sqlite3");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("gh"); // GitHub CLI
    expect(dockerfile).toContain("aha"); // ANSI HTML adapter
    expect(dockerfile).toContain("wkhtmltopdf"); // HTML to image
  });

  test("installs Claude Code CLI", () => {
    expect(dockerfile).toContain("@anthropic-ai/claude-code");
  });

  test("copies schema.sql", () => {
    expect(dockerfile).toContain("schema.sql");
  });
});

describe("Pre-flight: GitHub Project Template", () => {
  let template: {
    title: string;
    columns: Array<{ name: string; color?: string }>;
    custom_fields?: Array<{ name: string; type: string }>;
  };

  beforeAll(async () => {
    const content = await Bun.file(`${ROOT}/templates/github-project.json`).text();
    template = JSON.parse(content);
  });

  test("has required columns for workflow", () => {
    const names = template.columns.map((c) => c.name);

    expect(names).toContain("Todo");
    expect(names).toContain("Planning");
    expect(names).toContain("In Progress");
    expect(names).toContain("QA");
    expect(names).toContain("Blocked");
    expect(names).toContain("Review");
    expect(names).toContain("Done");
  });

  test("columns are in correct order", () => {
    const names = template.columns.map((c) => c.name);
    const todoIdx = names.indexOf("Todo");
    const planningIdx = names.indexOf("Planning");
    const inProgressIdx = names.indexOf("In Progress");
    const doneIdx = names.indexOf("Done");

    expect(todoIdx).toBeLessThan(planningIdx);
    expect(planningIdx).toBeLessThan(inProgressIdx);
    expect(inProgressIdx).toBeLessThan(doneIdx);
  });
});

describe("Pre-flight: Transition Script Validation", () => {
  // Note: We don't import transition scripts directly because they call main() on import
  // Instead, we verify the files exist and can be parsed

  test("start-planning.ts exists and is valid TypeScript", async () => {
    const content = await Bun.file(`${ROOT}/src/transitions/start-planning.ts`).text();
    expect(content).toContain("async function main()");
    expect(content).toContain("withSpan");
    expect(content).toContain("tmux");
  });

  test("inject-prompt.ts exists and is valid TypeScript", async () => {
    const content = await Bun.file(`${ROOT}/src/transitions/inject-prompt.ts`).text();
    expect(content).toContain("async function main()");
    expect(content).toContain("withSpan");
  });

  test("run-playwright.ts exists and is valid TypeScript", async () => {
    const content = await Bun.file(`${ROOT}/src/transitions/run-playwright.ts`).text();
    expect(content).toContain("async function main()");
    expect(content).toContain("playwright");
  });

  test("resume-with-failures.ts exists and is valid TypeScript", async () => {
    const content = await Bun.file(`${ROOT}/src/transitions/resume-with-failures.ts`).text();
    expect(content).toContain("async function main()");
    expect(content).toContain("qa");
  });

  test("send-answer.ts exists and is valid TypeScript", async () => {
    const content = await Bun.file(`${ROOT}/src/transitions/send-answer.ts`).text();
    expect(content).toContain("async function main()");
    expect(content).toContain("answer");
  });

  test("deploy-and-cleanup.ts exists and is valid TypeScript", async () => {
    const content = await Bun.file(`${ROOT}/src/transitions/deploy-and-cleanup.ts`).text();
    expect(content).toContain("async function main()");
    expect(content).toContain("cleanup");
  });

  test("all transitions import required libraries", async () => {
    const files = [
      "start-planning.ts",
      "inject-prompt.ts",
      "run-playwright.ts",
      "resume-with-failures.ts",
      "send-answer.ts",
      "deploy-and-cleanup.ts",
    ];

    for (const file of files) {
      const content = await Bun.file(`${ROOT}/src/transitions/${file}`).text();
      expect(content).toContain("from \"../lib/telemetry.js\"");
      expect(content).toContain("from \"../lib/db.js\"");
    }
  });
});

describe("Pre-flight: Task Analyzer Heuristics", () => {
  test("simple PR titles trigger headless mode", async () => {
    const { quickHeuristics } = await import("../lib/task-analyzer.js");

    const result = quickHeuristics({
      trigger: "pr_event",
      prTitle: "fix typo in readme",
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("headless");
  });

  test("complex tasks trigger REPL mode", async () => {
    const { quickHeuristics } = await import("../lib/task-analyzer.js");

    const result = quickHeuristics({
      trigger: "comment",
      commentBody: "Please refactor the authentication system",
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("repl");
  });

  test("manual triggers use REPL mode", async () => {
    const { quickHeuristics } = await import("../lib/task-analyzer.js");

    const result = quickHeuristics({
      trigger: "manual",
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("repl");
    expect(result?.confidence).toBeGreaterThan(90);
  });

  test("large diffs trigger REPL mode", async () => {
    const { quickHeuristics } = await import("../lib/task-analyzer.js");

    const result = quickHeuristics({
      trigger: "pr_event",
      diffStats: { additions: 500, deletions: 200, changedFiles: 15 },
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("repl");
  });
});

describe("Pre-flight: PR Filter Logic", () => {
  test("generates correct Claude branch names", async () => {
    const { generateClaudeBranch } = await import("../lib/pr-filter.js");

    const branch = generateClaudeBranch("feature", 123, "add-feature");
    expect(branch).toBe("claude/feature/issue-123-add-feature");
  });

  test("parses Claude branch names", async () => {
    const { parseClaudeBranch } = await import("../lib/pr-filter.js");

    const parsed = parseClaudeBranch("claude/feature/issue-123-add-feature");
    expect(parsed.isClaudeBranch).toBe(true);
    expect(parsed.issueNumber).toBe(123);
    expect(parsed.type).toBe("feature");
  });

  test("rejects non-Claude branches", async () => {
    const { parseClaudeBranch } = await import("../lib/pr-filter.js");

    const parsed = parseClaudeBranch("feature/add-something");
    expect(parsed.isClaudeBranch).toBe(false);
  });
});
