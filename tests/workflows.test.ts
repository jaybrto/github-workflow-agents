import { describe, test, expect } from "bun:test";
import * as yaml from "yaml";
import { readFileSync, existsSync } from "fs";

describe("Workflow Files", () => {
  describe("gwa-orchestrate.yml", () => {
    const workflowPath = ".github/workflows/gwa-orchestrate.yml";

    test("file exists", () => {
      expect(existsSync(workflowPath)).toBe(true);
    });

    test("is valid YAML", () => {
      const content = readFileSync(workflowPath, "utf-8");
      expect(() => yaml.parse(content)).not.toThrow();
    });

    test("defines workflow_call trigger", () => {
      const content = readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);
      expect(workflow.on.workflow_call).toBeDefined();
    });

    test("has required inputs", () => {
      const content = readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);
      const inputs = workflow.on.workflow_call.inputs;

      expect(inputs.pod_name).toBeDefined();
      expect(inputs.pod_name.required).toBe(true);
      expect(inputs.namespace).toBeDefined();
    });

    test("requires KUBECONFIG_DATA secret", () => {
      const content = readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);
      const secrets = workflow.on.workflow_call.secrets;

      expect(secrets.KUBECONFIG_DATA).toBeDefined();
      expect(secrets.KUBECONFIG_DATA.required).toBe(true);
    });

    test("has claude-work job", () => {
      const content = readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.jobs["claude-work"]).toBeDefined();
      expect(workflow.jobs["claude-work"]["runs-on"]).toBe("self-hosted");
    });

    test("sets up kubeconfig", () => {
      const content = readFileSync(workflowPath, "utf-8");
      expect(content).toContain("Setup kubeconfig");
      expect(content).toContain("~/.kube/config");
    });

    test("runs gwa-orchestrate command", () => {
      const content = readFileSync(workflowPath, "utf-8");
      expect(content).toContain("gwa-orchestrate");
      expect(content).toContain("kubectl exec");
    });
  });

  describe("gwa-respond.yml", () => {
    const workflowPath = ".github/workflows/gwa-respond.yml";

    test("file exists", () => {
      expect(existsSync(workflowPath)).toBe(true);
    });

    test("is valid YAML", () => {
      const content = readFileSync(workflowPath, "utf-8");
      expect(() => yaml.parse(content)).not.toThrow();
    });

    test("defines workflow_call trigger", () => {
      const content = readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);
      expect(workflow.on.workflow_call).toBeDefined();
    });

    test("has required inputs", () => {
      const content = readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);
      const inputs = workflow.on.workflow_call.inputs;

      expect(inputs.pod_name).toBeDefined();
      expect(inputs.pod_name.required).toBe(true);
      expect(inputs.pr_number).toBeDefined();
      expect(inputs.pr_number.required).toBe(true);
      expect(inputs.comment).toBeDefined();
      expect(inputs.comment.required).toBe(true);
    });

    test("runs gwa-respond command", () => {
      const content = readFileSync(workflowPath, "utf-8");
      expect(content).toContain("gwa-respond");
    });
  });

  describe("template: claude-code.yml", () => {
    const templatePath = "templates/workflows/claude-code.yml";

    test("file exists", () => {
      expect(existsSync(templatePath)).toBe(true);
    });

    test("is valid YAML", () => {
      const content = readFileSync(templatePath, "utf-8");
      expect(() => yaml.parse(content)).not.toThrow();
    });

    test("has placeholder values for onboarding script", () => {
      const content = readFileSync(templatePath, "utf-8");
      expect(content).toContain("__GWA_POD__");
      expect(content).toContain("__GWA_NAMESPACE__");
    });

    test("uses reusable workflows", () => {
      const content = readFileSync(templatePath, "utf-8");
      expect(content).toContain("jaybrto/github-workflow-agents/.github/workflows/gwa-orchestrate.yml");
      expect(content).toContain("jaybrto/github-workflow-agents/.github/workflows/gwa-respond.yml");
    });

    test("handles multiple event types", () => {
      const content = readFileSync(templatePath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.on.pull_request).toBeDefined();
      expect(workflow.on.issue_comment).toBeDefined();
      expect(workflow.on.workflow_dispatch).toBeDefined();
    });

    test("has orchestrate job with correct conditions", () => {
      const content = readFileSync(templatePath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.jobs.orchestrate).toBeDefined();
      expect(workflow.jobs.orchestrate.if).toContain("pull_request");
      expect(workflow.jobs.orchestrate.if).toContain("@claude");
    });

    test("has respond job for @claude-answer", () => {
      const content = readFileSync(templatePath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.jobs.respond).toBeDefined();
      expect(workflow.jobs.respond.if).toContain("@claude-answer:");
    });

    test("references GWA_KUBECONFIG secret", () => {
      const content = readFileSync(templatePath, "utf-8");
      expect(content).toContain("GWA_KUBECONFIG");
    });
  });
});

describe("ArgoCD ApplicationSet", () => {
  const applicationSetPath = "argocd/applicationset.yaml";

  test("file exists", () => {
    expect(existsSync(applicationSetPath)).toBe(true);
  });

  test("is valid YAML", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    expect(() => yaml.parse(content)).not.toThrow();
  });

  test("has correct apiVersion", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    expect(appSet.apiVersion).toBe("argoproj.io/v1alpha1");
  });

  test("has correct kind", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    expect(appSet.kind).toBe("ApplicationSet");
  });

  test("uses list generator", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    expect(appSet.spec.generators[0].list).toBeDefined();
    expect(appSet.spec.generators[0].list.elements).toBeInstanceOf(Array);
  });

  test("has initial repo entry", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    const elements = appSet.spec.generators[0].list.elements;

    const gwaEntry = elements.find(
      (e: any) => e.repoOwner === "jaybrto" && e.repoName === "github-workflow-agents"
    );
    expect(gwaEntry).toBeDefined();
  });

  test("uses helm chart from correct path", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    expect(appSet.spec.template.spec.source.path).toBe("helm/gwa-runner");
  });

  test("passes repo.owner and repo.name as helm parameters", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    const params = appSet.spec.template.spec.source.helm.parameters;

    const ownerParam = params.find((p: any) => p.name === "repo.owner");
    const nameParam = params.find((p: any) => p.name === "repo.name");

    expect(ownerParam).toBeDefined();
    expect(ownerParam.value).toBe("{{repoOwner}}");
    expect(nameParam).toBeDefined();
    expect(nameParam.value).toBe("{{repoName}}");
  });

  test("creates namespace from template", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    expect(appSet.spec.template.spec.destination.namespace).toBe("gwa-{{repoOwner}}-{{repoName}}");
  });

  test("has automated sync policy", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    const syncPolicy = appSet.spec.template.spec.syncPolicy;

    expect(syncPolicy.automated).toBeDefined();
    expect(syncPolicy.automated.prune).toBe(true);
    expect(syncPolicy.automated.selfHeal).toBe(true);
  });

  test("creates namespace on sync", () => {
    const content = readFileSync(applicationSetPath, "utf-8");
    const appSet = yaml.parse(content);
    const syncOptions = appSet.spec.template.spec.syncPolicy.syncOptions;

    expect(syncOptions).toContain("CreateNamespace=true");
  });
});
