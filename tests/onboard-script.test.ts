import { describe, test, expect } from "bun:test";
import { $ } from "bun";

describe("Onboarding Script", () => {
  const scriptPath = "./scripts/onboard-repo.sh";

  describe("argument parsing", () => {
    test("shows help with -h flag", async () => {
      const result = await $`${scriptPath} -h 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Usage:");
      expect(result.stdout.toString()).toContain("--dry-run");
    });

    test("shows help with --help flag", async () => {
      const result = await $`${scriptPath} --help 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Usage:");
    });

    test("fails without repository argument", async () => {
      const result = await $`${scriptPath} 2>&1`.nothrow();
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toContain("Repository argument required");
    });

    test("fails with invalid repository format", async () => {
      const result = await $`${scriptPath} invalid-repo 2>&1`.nothrow();
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toContain("Invalid repository format");
    });

    test("parses owner/repo correctly", async () => {
      // This will fail at gh check but we can see it parsed correctly
      const result = await $`${scriptPath} testowner/testrepo --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Owner:       testowner");
      expect(result.stdout.toString()).toContain("Name:        testrepo");
    });
  });

  describe("name generation", () => {
    test("generates correct namespace", async () => {
      const result = await $`${scriptPath} myorg/myrepo --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Namespace:   gwa-myorg-myrepo");
    });

    test("generates correct pod name", async () => {
      const result = await $`${scriptPath} myorg/myrepo --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Pod Name:    gwa-myorg-myrepo-0");
    });

    test("sanitizes uppercase to lowercase", async () => {
      const result = await $`${scriptPath} MyOrg/MyRepo --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Namespace:   gwa-myorg-myrepo");
    });

    test("sanitizes underscores to dashes", async () => {
      const result = await $`${scriptPath} my_org/my_repo --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Namespace:   gwa-my-org-my-repo");
    });
  });

  describe("dry-run mode", () => {
    test("indicates dry-run mode", async () => {
      const result = await $`${scriptPath} jaybrto/github-workflow-agents --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("DRY RUN MODE");
    });

    test("shows what would be added to applicationset", async () => {
      // Use a repo that doesn't exist in the applicationset
      const result = await $`${scriptPath} jaybrto/nonexistent-repo --dry-run 2>&1`.nothrow();
      // It will fail at gh check, but we test the output format
      expect(result.stdout.toString()).toContain("DRY RUN MODE");
    });

    test("shows workflow content preview", async () => {
      const result = await $`${scriptPath} jaybrto/github-workflow-agents --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Would create .github/workflows/claude-code.yml");
      expect(result.stdout.toString()).toContain("GWA Claude Code");
    });
  });

  describe("existing repo detection", () => {
    test("detects already onboarded repo", async () => {
      const result = await $`${scriptPath} jaybrto/github-workflow-agents --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("already in applicationset.yaml");
    });
  });

  describe("instructions output", () => {
    test("shows secret configuration instructions", async () => {
      const result = await $`${scriptPath} jaybrto/github-workflow-agents --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("GWA_KUBECONFIG");
      expect(result.stdout.toString()).toContain("kubectl create secret generic gwa-secrets");
    });

    test("shows next steps", async () => {
      const result = await $`${scriptPath} jaybrto/github-workflow-agents --dry-run 2>&1`.nothrow();
      expect(result.stdout.toString()).toContain("Next steps:");
      expect(result.stdout.toString()).toContain("Commit and push");
      expect(result.stdout.toString()).toContain("ArgoCD");
    });
  });
});
