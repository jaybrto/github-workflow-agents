/**
 * Template files existence tests
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "../..");

describe("Template Files", () => {
  test("templates/plans directory exists", () => {
    expect(existsSync(`${ROOT}/templates/plans`)).toBe(true);
  });

  test("plan.md template exists", () => {
    expect(existsSync(`${ROOT}/templates/plans/plan.md`)).toBe(true);
  });

  test("prompt.md template exists", () => {
    expect(existsSync(`${ROOT}/templates/plans/prompt.md`)).toBe(true);
  });

  test("checklist.md template exists", () => {
    expect(existsSync(`${ROOT}/templates/plans/checklist.md`)).toBe(true);
  });

  test("decisions.md template exists", () => {
    expect(existsSync(`${ROOT}/templates/plans/decisions.md`)).toBe(true);
  });

  test("snippets.md template exists", () => {
    expect(existsSync(`${ROOT}/templates/plans/snippets.md`)).toBe(true);
  });

  test("github-project.json template exists", () => {
    expect(existsSync(`${ROOT}/templates/github-project.json`)).toBe(true);
  });

  test("github-project.json has valid JSON", async () => {
    const content = await Bun.file(`${ROOT}/templates/github-project.json`).text();
    const parsed = JSON.parse(content);

    expect(parsed.title).toBeDefined();
    expect(parsed.columns).toBeDefined();
    expect(Array.isArray(parsed.columns)).toBe(true);
    expect(parsed.columns.length).toBeGreaterThan(0);
  });

  test("github-project.json has required columns", async () => {
    const content = await Bun.file(`${ROOT}/templates/github-project.json`).text();
    const parsed = JSON.parse(content);
    const columnNames = parsed.columns.map((c: { name: string }) => c.name);

    expect(columnNames).toContain("Todo");
    expect(columnNames).toContain("Planning");
    expect(columnNames).toContain("In Progress");
    expect(columnNames).toContain("QA");
    expect(columnNames).toContain("Review");
    expect(columnNames).toContain("Done");
  });
});

describe("Transition Scripts", () => {
  test("start-planning.ts exists", () => {
    expect(existsSync(`${ROOT}/src/transitions/start-planning.ts`)).toBe(true);
  });

  test("inject-prompt.ts exists", () => {
    expect(existsSync(`${ROOT}/src/transitions/inject-prompt.ts`)).toBe(true);
  });

  test("run-playwright.ts exists", () => {
    expect(existsSync(`${ROOT}/src/transitions/run-playwright.ts`)).toBe(true);
  });

  test("resume-with-failures.ts exists", () => {
    expect(existsSync(`${ROOT}/src/transitions/resume-with-failures.ts`)).toBe(true);
  });

  test("send-answer.ts exists", () => {
    expect(existsSync(`${ROOT}/src/transitions/send-answer.ts`)).toBe(true);
  });

  test("deploy-and-cleanup.ts exists", () => {
    expect(existsSync(`${ROOT}/src/transitions/deploy-and-cleanup.ts`)).toBe(true);
  });
});

describe("Core Entry Points", () => {
  test("orchestrate.ts exists", () => {
    expect(existsSync(`${ROOT}/src/orchestrate.ts`)).toBe(true);
  });

  test("respond.ts exists", () => {
    expect(existsSync(`${ROOT}/src/respond.ts`)).toBe(true);
  });

  test("cleanup.ts exists", () => {
    expect(existsSync(`${ROOT}/src/cleanup.ts`)).toBe(true);
  });

  test("architect.ts exists", () => {
    expect(existsSync(`${ROOT}/src/architect.ts`)).toBe(true);
  });

  test("worker.ts exists", () => {
    expect(existsSync(`${ROOT}/src/worker.ts`)).toBe(true);
  });

  test("setup-project.ts exists", () => {
    expect(existsSync(`${ROOT}/src/setup-project.ts`)).toBe(true);
  });
});

describe("Infrastructure Files", () => {
  test("schema.sql exists", () => {
    expect(existsSync(`${ROOT}/schema.sql`)).toBe(true);
  });

  test("Dockerfile exists", () => {
    expect(existsSync(`${ROOT}/Dockerfile`)).toBe(true);
  });

  test("package.json exists", () => {
    expect(existsSync(`${ROOT}/package.json`)).toBe(true);
  });

  test("tsconfig.json exists", () => {
    expect(existsSync(`${ROOT}/tsconfig.json`)).toBe(true);
  });

  test("k8s manifests exist", () => {
    expect(existsSync(`${ROOT}/k8s`)).toBe(true);
    expect(existsSync(`${ROOT}/k8s/gwa-runner-configmap.yaml`)).toBe(true);
    expect(existsSync(`${ROOT}/k8s/gwa-runner-statefulset.yaml`)).toBe(true);
  });
});
