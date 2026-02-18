/**
 * Dialog handler unit tests.
 * Tests parseDialogResponse validation and ClaudeDialogError class.
 */
import { describe, test, expect } from "bun:test";
import { ClaudeDialogError, parseDialogResponse } from "../lib/dialog-handler.js";

describe("ClaudeDialogError", () => {
  test("has correct name", () => {
    const err = new ClaudeDialogError("test message", "captured output");
    expect(err.name).toBe("ClaudeDialogError");
  });

  test("has correct message", () => {
    const err = new ClaudeDialogError("dialog stuck", "pane text");
    expect(err.message).toBe("dialog stuck");
  });

  test("stores capturedOutput", () => {
    const err = new ClaudeDialogError("msg", "terminal output here");
    expect(err.capturedOutput).toBe("terminal output here");
  });

  test("is instanceof Error", () => {
    const err = new ClaudeDialogError("msg", "output");
    expect(err instanceof Error).toBe(true);
  });

  test("is instanceof ClaudeDialogError", () => {
    const err = new ClaudeDialogError("msg", "output");
    expect(err instanceof ClaudeDialogError).toBe(true);
  });
});

describe("parseDialogResponse", () => {
  test("parses blocked: false response", () => {
    const result = parseDialogResponse('{"blocked": false}');
    expect(result.blocked).toBe(false);
    expect(result.keys).toEqual([]);
    expect(result.reason).toBe("");
  });

  test("parses blocked: true with valid keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Down", "Enter"], "reason": "Accept dialog"}'
    );
    expect(result.blocked).toBe(true);
    expect(result.keys).toEqual(["Down", "Enter"]);
    expect(result.reason).toBe("Accept dialog");
  });

  test("filters out invalid key names", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Down", "rm -rf /", "Enter", "InvalidKey"], "reason": "test"}'
    );
    expect(result.keys).toEqual(["Down", "Enter"]);
  });

  test("enforces max 10 keys", () => {
    const keys = Array(15).fill("Enter");
    const result = parseDialogResponse(
      JSON.stringify({ blocked: true, keys, reason: "many keys" })
    );
    expect(result.keys.length).toBe(10);
  });

  test("handles missing keys field", () => {
    const result = parseDialogResponse('{"blocked": true, "reason": "no keys"}');
    expect(result.blocked).toBe(true);
    expect(result.keys).toEqual([]);
  });

  test("handles missing reason field", () => {
    const result = parseDialogResponse('{"blocked": true, "keys": ["Enter"]}');
    expect(result.reason).toBe("");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseDialogResponse("not json")).toThrow();
  });

  test("accepts single digit keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["1", "2", "y", "n"], "reason": "select option"}'
    );
    expect(result.keys).toEqual(["1", "2", "y", "n"]);
  });

  test("handles whitespace around JSON", () => {
    const result = parseDialogResponse('  {"blocked": false}  \n');
    expect(result.blocked).toBe(false);
  });

  test("filters non-string keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Enter", 42, null, "Down"], "reason": "test"}'
    );
    expect(result.keys).toEqual(["Enter", "Down"]);
  });

  test("all allowed keys are accepted", () => {
    const allKeys = ["Down", "Up", "Enter", "Tab", "Space", "Escape", "y", "n", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const result = parseDialogResponse(
      JSON.stringify({ blocked: true, keys: allKeys.slice(0, 10), reason: "all keys" })
    );
    expect(result.keys.length).toBe(10);
    // Test remaining keys separately since max is 10
    const result2 = parseDialogResponse(
      JSON.stringify({ blocked: true, keys: allKeys.slice(10), reason: "remaining keys" })
    );
    expect(result2.keys.length).toBe(allKeys.length - 10);
  });
});
