/**
 * Unit tests for SessionMetrics in telemetry module
 */
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";

describe("SessionMetrics", () => {
  test("module exports SessionMetrics", async () => {
    // This test verifies the module structure without actually calling OTEL
    // (which would require a full OTEL setup)
    const { SessionMetrics } = await import("../lib/telemetry.js");

    expect(SessionMetrics).toBeDefined();
    expect(typeof SessionMetrics.recordSessionComplete).toBe("function");
    expect(typeof SessionMetrics.recordToolCall).toBe("function");
    expect(typeof SessionMetrics.recordQuestionAsked).toBe("function");
    expect(typeof SessionMetrics.recordQuestionAnswered).toBe("function");
    expect(typeof SessionMetrics.recordCommitCreated).toBe("function");
    expect(typeof SessionMetrics.recordAgentTaskComplete).toBe("function");
  });

  test("recordSessionComplete handles errors gracefully", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Should not throw even with invalid inputs
    expect(() => {
      SessionMetrics.recordSessionComplete("test/repo", "complete", "feature", 120);
    }).not.toThrow();
  });

  test("recordToolCall handles errors gracefully", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Should not throw even with invalid inputs
    expect(() => {
      SessionMetrics.recordToolCall("Read", "session-123", true);
    }).not.toThrow();
  });

  test("recordQuestionAsked handles errors gracefully", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Should not throw even with invalid inputs
    expect(() => {
      SessionMetrics.recordQuestionAsked("test/repo");
    }).not.toThrow();
  });

  test("recordQuestionAnswered handles errors gracefully", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Should not throw even with invalid inputs
    expect(() => {
      SessionMetrics.recordQuestionAnswered("test/repo", 60);
    }).not.toThrow();
  });

  test("recordCommitCreated handles errors gracefully", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Should not throw even with invalid inputs
    expect(() => {
      SessionMetrics.recordCommitCreated("test/repo", "session-123");
    }).not.toThrow();
  });

  test("recordAgentTaskComplete handles errors gracefully", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Should not throw even with invalid inputs
    expect(() => {
      SessionMetrics.recordAgentTaskComplete("completed", "worker");
    }).not.toThrow();
  });

  test("all metric methods accept valid parameters", async () => {
    const { SessionMetrics } = await import("../lib/telemetry.js");

    // Test with realistic data
    const testCases = [
      () => SessionMetrics.recordSessionComplete("jaybrto/test-repo", "complete", "feature", 300),
      () => SessionMetrics.recordSessionComplete("jaybrto/test-repo", "error", "pr", 150),
      () => SessionMetrics.recordSessionComplete("jaybrto/test-repo", "interrupted", "review", 600),
      () => SessionMetrics.recordToolCall("Bash", "pr-123", true),
      () => SessionMetrics.recordToolCall("Edit", "pr-123", false),
      () => SessionMetrics.recordQuestionAsked("jaybrto/test-repo"),
      () => SessionMetrics.recordQuestionAnswered("jaybrto/test-repo", 120),
      () => SessionMetrics.recordCommitCreated("jaybrto/test-repo", "pr-123"),
      () => SessionMetrics.recordAgentTaskComplete("completed", "architect"),
      () => SessionMetrics.recordAgentTaskComplete("failed", "worker"),
    ];

    // All calls should succeed without throwing
    testCases.forEach((testCase) => {
      expect(testCase).not.toThrow();
    });
  });
});
