import { describe, test, expect, beforeAll } from "bun:test";
import { $ } from "bun";
import * as yaml from "yaml";

describe("Helm Chart: gwa-runner", () => {
  const chartPath = "./helm/gwa-runner";

  describe("template rendering", () => {
    test("renders with required values", async () => {
      const result =
        await $`helm template test ${chartPath} --set repo.owner=testowner --set repo.name=testrepo`.text();
      expect(result).toContain("gwa-testowner-testrepo");
    });

    test("fails without repo.owner", async () => {
      const result =
        await $`helm template test ${chartPath} --set repo.name=testrepo 2>&1`.nothrow();
      // Chart should render but with empty owner
      expect(result.stdout.toString()).toContain("gwa--testrepo");
    });

    test("sanitizes names correctly", async () => {
      const result =
        await $`helm template test ${chartPath} --set repo.owner=Test_Owner --set repo.name=My_Repo`.text();
      // Resource names should be lowercase with underscores replaced by dashes
      expect(result).toContain("name: gwa-test-owner-my-repo");
      // Labels preserve original values for traceability
      expect(result).toContain('gwa.io/repo-owner: "Test_Owner"');
      expect(result).toContain('gwa.io/repo-name: "My_Repo"');
    });

    test("truncates long names to 63 characters", async () => {
      const longOwner = "a".repeat(40);
      const longName = "b".repeat(40);
      const result =
        await $`helm template test ${chartPath} --set repo.owner=${longOwner} --set repo.name=${longName}`.text();

      // Parse YAML to check resource names
      const docs = yaml.parseAllDocuments(result);
      for (const doc of docs) {
        const obj = doc.toJSON();
        if (obj?.metadata?.name) {
          // Resource names must be ≤63 chars (K8s limit)
          expect(obj.metadata.name.length).toBeLessThanOrEqual(63);
        }
      }
      // Verify base name is truncated: gwa- (4) + owner (40) + dash (1) + name (3 of 40) = 48 chars
      // This leaves 15 chars for longest suffix (-actions-runner)
      expect(result).toContain("name: gwa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbb\n");
    });
  });

  describe("resource generation", () => {
    let renderedYaml: string;
    let resources: any[];

    beforeAll(async () => {
      renderedYaml =
        await $`helm template test ${chartPath} --set repo.owner=jaybrto --set repo.name=myapp`.text();
      resources = yaml.parseAllDocuments(renderedYaml).map((doc) => doc.toJSON());
    });

    test("creates StatefulSet", () => {
      const sts = resources.find(
        (r) => r?.kind === "StatefulSet" && r?.metadata?.name === "gwa-jaybrto-myapp"
      );
      expect(sts).toBeDefined();
      expect(sts.spec.serviceName).toBe("gwa-jaybrto-myapp");
      expect(sts.spec.replicas).toBe(1);
    });

    test("creates ConfigMap with entrypoint script", () => {
      const cm = resources.find(
        (r) => r?.kind === "ConfigMap" && r?.metadata?.name === "gwa-jaybrto-myapp-init"
      );
      expect(cm).toBeDefined();
      expect(cm.data["entrypoint.sh"]).toContain("jaybrto/myapp");
    });

    test("creates headless Service", () => {
      const svc = resources.find(
        (r) => r?.kind === "Service" && r?.metadata?.name === "gwa-jaybrto-myapp"
      );
      expect(svc).toBeDefined();
      expect(svc.spec.clusterIP).toBe("None");
    });

    test("creates CronJob for cleanup", () => {
      const cj = resources.find(
        (r) => r?.kind === "CronJob" && r?.metadata?.name === "gwa-jaybrto-myapp-cleanup"
      );
      expect(cj).toBeDefined();
      expect(cj.spec.schedule).toBe("0 * * * *");
    });

    test("creates Deployment for actions runner", () => {
      const deploy = resources.find(
        (r) => r?.kind === "Deployment" && r?.metadata?.name === "gwa-jaybrto-myapp-actions-runner"
      );
      expect(deploy).toBeDefined();
      expect(deploy.spec.replicas).toBe(1);
    });

    test("creates RBAC resources", () => {
      const serviceAccounts = resources.filter((r) => r?.kind === "ServiceAccount");
      const roles = resources.filter((r) => r?.kind === "Role");
      const roleBindings = resources.filter((r) => r?.kind === "RoleBinding");

      expect(serviceAccounts.length).toBeGreaterThanOrEqual(2);
      expect(roles.length).toBeGreaterThanOrEqual(2);
      expect(roleBindings.length).toBeGreaterThanOrEqual(2);
    });

    test("sets correct labels", () => {
      const sts = resources.find((r) => r?.kind === "StatefulSet");
      expect(sts.metadata.labels["gwa.io/repo-owner"]).toBe("jaybrto");
      expect(sts.metadata.labels["gwa.io/repo-name"]).toBe("myapp");
      expect(sts.metadata.labels["app.kubernetes.io/part-of"]).toBe("github-workflow-agents");
    });

    test("configures volume claim templates", () => {
      const sts = resources.find((r) => r?.kind === "StatefulSet");
      const vcts = sts.spec.volumeClaimTemplates;

      expect(vcts.length).toBe(3);

      const names = vcts.map((v: any) => v.metadata.name);
      expect(names).toContain("claude-session");
      expect(names).toContain("worktrees");
      expect(names).toContain("repo");
    });
  });

  describe("environment variables", () => {
    let renderedYaml: string;
    let statefulSet: any;

    beforeAll(async () => {
      renderedYaml =
        await $`helm template test ${chartPath} --set repo.owner=jaybrto --set repo.name=myapp`.text();
      const resources = yaml.parseAllDocuments(renderedYaml).map((doc) => doc.toJSON());
      statefulSet = resources.find((r) => r?.kind === "StatefulSet");
    });

    test("sets REPO environment variable", () => {
      const container = statefulSet.spec.template.spec.containers[0];
      const repoEnv = container.env.find((e: any) => e.name === "REPO");
      expect(repoEnv.value).toBe("jaybrto/myapp");
    });

    test("does not set Redis environment variables", () => {
      const container = statefulSet.spec.template.spec.containers[0];
      const redisHost = container.env.find((e: any) => e.name === "REDIS_HOST");
      const redisPort = container.env.find((e: any) => e.name === "REDIS_PORT");

      expect(redisHost).toBeUndefined();
      expect(redisPort).toBeUndefined();
    });

    // TODO: Add RabbitMQ env var assertion once AMQP backbone is implemented
    // test("sets RabbitMQ environment variables", () => {
    //   const container = statefulSet.spec.template.spec.containers[0];
    //   const rabbitmqUrl = container.env.find((e: any) => e.name === "RABBITMQ_URL");
    //   expect(rabbitmqUrl).toBeDefined();
    // });

    test("sets OpenTelemetry environment variables", () => {
      const container = statefulSet.spec.template.spec.containers[0];
      const otelEndpoint = container.env.find((e: any) => e.name === "OTEL_EXPORTER_OTLP_ENDPOINT");
      const otelServiceName = container.env.find((e: any) => e.name === "OTEL_SERVICE_NAME");

      expect(otelEndpoint).toBeDefined();
      expect(otelServiceName).toBeDefined();
    });

    test("references secrets correctly", () => {
      const container = statefulSet.spec.template.spec.containers[0];
      const claudeToken = container.env.find((e: any) => e.name === "CLAUDE_CODE_OAUTH_TOKEN");
      const githubToken = container.env.find((e: any) => e.name === "GITHUB_TOKEN");

      expect(claudeToken.valueFrom.secretKeyRef.name).toBe("gwa-secrets");
      expect(githubToken.valueFrom.secretKeyRef.name).toBe("gwa-secrets");
    });
  });

  describe("optional components", () => {
    test("can disable actions runner", async () => {
      const result =
        await $`helm template test ${chartPath} --set repo.owner=jaybrto --set repo.name=myapp --set actionsRunner.enabled=false`.text();

      expect(result).not.toContain("actions-runner");
    });

    test("can disable cleanup cronjob", async () => {
      const result =
        await $`helm template test ${chartPath} --set repo.owner=jaybrto --set repo.name=myapp --set cleanup.enabled=false`.text();

      const resources = yaml.parseAllDocuments(result).map((doc) => doc.toJSON());
      const cronjob = resources.find((r) => r?.kind === "CronJob");
      expect(cronjob).toBeUndefined();
    });

    test("can disable OpenTelemetry", async () => {
      const result =
        await $`helm template test ${chartPath} --set repo.owner=jaybrto --set repo.name=myapp --set otel.enabled=false`.text();

      expect(result).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    });
  });

  describe("helm lint", () => {
    test("passes lint check", async () => {
      const result =
        await $`helm lint ${chartPath} --set repo.owner=jaybrto --set repo.name=myapp 2>&1`.nothrow();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("0 chart(s) failed");
    });
  });
});
