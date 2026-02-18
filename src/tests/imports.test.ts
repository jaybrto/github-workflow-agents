/**
 * Import/Export validation tests
 * Ensures all modules can be imported and export expected functions
 */
import { describe, test, expect } from "bun:test";

describe("Library Imports", () => {
  test("db.ts exports required functions", async () => {
    const db = await import("../lib/db.js");

    expect(typeof db.initDatabase).toBe("function");
    expect(typeof db.getDatabase).toBe("function");
    expect(typeof db.getSession).toBe("function");
    expect(typeof db.createSession).toBe("function");
    expect(typeof db.updateSessionStatus).toBe("function");
    expect(typeof db.logActivity).toBe("function");
    expect(typeof db.createQuestion).toBe("function");
    expect(typeof db.answerQuestion).toBe("function");
    expect(typeof db.getPendingQuestion).toBe("function");
  });

  test("tmux.ts exports required functions", async () => {
    const tmux = await import("../lib/tmux.js");

    expect(typeof tmux.ensureSession).toBe("function");
    expect(typeof tmux.createWindow).toBe("function");
    expect(typeof tmux.windowExists).toBe("function");
    expect(typeof tmux.sendCommand).toBe("function");
    expect(typeof tmux.sendKeys).toBe("function");
    expect(typeof tmux.killWindow).toBe("function");
    expect(typeof tmux.capturePane).toBe("function");
  });

  test("github.ts exports required functions", async () => {
    const github = await import("../lib/github.js");

    expect(typeof github.getOctokit).toBe("function");
    expect(typeof github.postPRComment).toBe("function");
    expect(typeof github.getPRDetails).toBe("function");
    expect(typeof github.postQuestion).toBe("function");
  });

  test("telemetry.ts exports required functions", async () => {
    const telemetry = await import("../lib/telemetry.js");

    expect(typeof telemetry.withSpan).toBe("function");
    expect(typeof telemetry.log).toBe("function");
    expect(typeof telemetry.shutdown).toBe("function");
    expect(typeof telemetry.Metrics).toBe("object");
  });

  test("swarm.ts exports required functions", async () => {
    const swarm = await import("../lib/swarm.js");

    expect(typeof swarm.createSwarmSession).toBe("function");
    expect(typeof swarm.spawnWorker).toBe("function");
    expect(typeof swarm.startWorker).toBe("function");
    expect(typeof swarm.checkTaskCompletion).toBe("function");
    expect(typeof swarm.aggregateResults).toBe("function");
    expect(typeof swarm.cleanupSwarm).toBe("function");
    expect(typeof swarm.ensureAgentTasksTable).toBe("function");
  });

  test("repl-session.ts exports required functions", async () => {
    const repl = await import("../lib/repl-session.js");

    expect(typeof repl.startREPL).toBe("function");
    expect(typeof repl.sendToREPL).toBe("function");
    expect(typeof repl.getREPLStatus).toBe("function");
    expect(typeof repl.stopREPL).toBe("function");
    expect(typeof repl.captureREPLOutput).toBe("function");
  });

  test("comment-generator.ts exports required functions", async () => {
    const comments = await import("../lib/comment-generator.js");

    expect(typeof comments.generateComment).toBe("function");
  });

  test("task-analyzer.ts exports required functions", async () => {
    const analyzer = await import("../lib/task-analyzer.js");

    expect(typeof analyzer.analyzeTaskComplexity).toBe("function");
    expect(typeof analyzer.quickHeuristics).toBe("function");
  });

  test("pr-filter.ts exports required functions", async () => {
    const filter = await import("../lib/pr-filter.js");

    expect(typeof filter.shouldProcessPR).toBe("function");
    expect(typeof filter.labelPRAsClaudeCreated).toBe("function");
    expect(typeof filter.generateClaudeBranch).toBe("function");
    expect(typeof filter.parseClaudeBranch).toBe("function");
  });

  test("plan-sync.ts exports required functions", async () => {
    const planSync = await import("../lib/plan-sync.js");

    expect(typeof planSync.linkPlanToIssue).toBe("function");
    expect(typeof planSync.postPlanSummary).toBe("function");
  });

  test("projects.ts exports required functions", async () => {
    const projects = await import("../lib/projects.js");

    expect(typeof projects.getProject).toBe("function");
    expect(typeof projects.moveToColumn).toBe("function");
    expect(projects.COLUMNS).toBeDefined();
    expect(projects.CUSTOM_FIELDS).toBeDefined();
  });
});
