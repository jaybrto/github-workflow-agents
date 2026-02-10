/**
 * PR Filter - Filter triggers to only Claude-created PRs
 *
 * Ensures workflows only trigger on PRs that were created by Claude,
 * preventing accidental processing of human-created PRs.
 */

import { getOctokit } from "./github.js";
import { withSpan, Metrics, log } from "./telemetry.js";

// ============================================================================
// Types
// ============================================================================

export interface PRFilterResult {
  shouldProcess: boolean;
  reason: string;
  metadata?: {
    branch: string;
    hasLabel: boolean;
    createdBy: string;
  };
}

export interface FilterConfig {
  /** Branch prefix that indicates Claude-created PRs (default: "claude/") */
  branchPrefix?: string;
  /** Label that indicates Claude-created PRs (default: "created-by-claude") */
  requiredLabel?: string;
  /** Whether both conditions must be true (default: true) */
  requireBoth?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BRANCH_PREFIX = "claude/";
const DEFAULT_LABEL = "created-by-claude";

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if a PR was created by Claude and should be processed.
 *
 * By default, requires BOTH:
 * 1. Branch name starts with "claude/"
 * 2. PR has "created-by-claude" label
 */
export async function shouldProcessPR(
  owner: string,
  repo: string,
  prNumber: number,
  config: FilterConfig = {}
): Promise<PRFilterResult> {
  return withSpan("pr-filter.shouldProcess", async (span) => {
    span.setAttribute("pr.number", prNumber);
    span.setAttribute("pr.repo", `${owner}/${repo}`);

    const branchPrefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    const requiredLabel = config.requiredLabel ?? DEFAULT_LABEL;
    const requireBoth = config.requireBoth ?? true;

    const client = getOctokit();

    try {
      const { data: pr } = await client.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      Metrics.recordGitHubApiCall("pulls.get.filter", true);

      const branch = pr.head.ref;
      const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name));
      const createdBy = pr.user?.login || "unknown";

      const hasBranchPrefix = branch.startsWith(branchPrefix);
      const hasLabel = labels.includes(requiredLabel);

      span.setAttribute("pr.branch", branch);
      span.setAttribute("pr.has_branch_prefix", hasBranchPrefix);
      span.setAttribute("pr.has_label", hasLabel);
      span.setAttribute("pr.created_by", createdBy);

      const metadata = {
        branch,
        hasLabel,
        createdBy,
      };

      // Determine if we should process based on config
      let shouldProcess: boolean;
      let reason: string;

      if (requireBoth) {
        shouldProcess = hasBranchPrefix && hasLabel;
        if (!shouldProcess) {
          const missing: string[] = [];
          if (!hasBranchPrefix) missing.push(`branch prefix "${branchPrefix}"`);
          if (!hasLabel) missing.push(`label "${requiredLabel}"`);
          reason = `Missing: ${missing.join(" and ")}`;
        } else {
          reason = "Claude-created PR detected";
        }
      } else {
        shouldProcess = hasBranchPrefix || hasLabel;
        if (shouldProcess) {
          reason = hasBranchPrefix
            ? `Branch starts with "${branchPrefix}"`
            : `Has label "${requiredLabel}"`;
        } else {
          reason = `Neither branch prefix "${branchPrefix}" nor label "${requiredLabel}" present`;
        }
      }

      log(shouldProcess ? "info" : "debug", "PR filter result", {
        prNumber,
        shouldProcess,
        reason,
        branch,
        hasLabel,
      });

      span.setAttribute("pr.should_process", shouldProcess);
      span.setAttribute("pr.filter_reason", reason);

      return { shouldProcess, reason, metadata };
    } catch (error) {
      Metrics.recordGitHubApiCall("pulls.get.filter", false);

      const errorMessage = error instanceof Error ? error.message : String(error);
      log("error", "Failed to check PR", { prNumber, error: errorMessage });

      return {
        shouldProcess: false,
        reason: `Failed to fetch PR: ${errorMessage}`,
      };
    }
  });
}

/**
 * Quick check if a branch name indicates a Claude-created PR.
 * Use this for fast filtering before making API calls.
 */
export function isClaaudeBranch(branch: string, prefix: string = DEFAULT_BRANCH_PREFIX): boolean {
  return branch.startsWith(prefix);
}

/**
 * Add the "created-by-claude" label to a PR.
 * Called when Claude creates a new PR.
 */
export async function labelPRAsClaudeCreated(
  owner: string,
  repo: string,
  prNumber: number,
  label: string = DEFAULT_LABEL
): Promise<void> {
  return withSpan("pr-filter.labelPR", async (span) => {
    span.setAttribute("pr.number", prNumber);
    span.setAttribute("pr.label", label);

    const client = getOctokit();

    // Ensure label exists in repo
    try {
      await client.issues.getLabel({ owner, repo, name: label });
    } catch {
      // Label doesn't exist, create it
      await client.issues.createLabel({
        owner,
        repo,
        name: label,
        color: "7B68EE", // Medium purple
        description: "PR was created by Claude Code automation",
      });
      log("info", "Created label", { label, repo: `${owner}/${repo}` });
    }

    // Add label to PR
    await client.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [label],
    });

    Metrics.recordGitHubApiCall("issues.addLabels", true);
    log("info", "Labeled PR as Claude-created", { prNumber, label });
  });
}

/**
 * Generate a Claude-style branch name for a new feature.
 */
export function generateClaudeBranch(
  type: "feature" | "fix" | "refactor" | "docs",
  issueNumber: number,
  description: string,
  prefix: string = DEFAULT_BRANCH_PREFIX
): string {
  // Sanitize description: lowercase, replace spaces with hyphens, remove special chars
  const sanitized = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50); // Limit length

  return `${prefix}${type}/issue-${issueNumber}-${sanitized}`;
}

/**
 * Parse a Claude branch name to extract metadata.
 */
export function parseClaudeBranch(
  branch: string,
  prefix: string = DEFAULT_BRANCH_PREFIX
): {
  isClaudeBranch: boolean;
  type?: string;
  issueNumber?: number;
  description?: string;
} {
  if (!branch.startsWith(prefix)) {
    return { isClaudeBranch: false };
  }

  const withoutPrefix = branch.slice(prefix.length);
  const match = withoutPrefix.match(/^(feature|fix|refactor|docs)\/issue-(\d+)-(.+)$/);

  if (!match) {
    return { isClaudeBranch: true };
  }

  return {
    isClaudeBranch: true,
    type: match[1],
    issueNumber: parseInt(match[2], 10),
    description: match[3],
  };
}

/**
 * Filter a list of PRs to only those created by Claude.
 */
export async function filterClaudePRs(
  owner: string,
  repo: string,
  prNumbers: number[],
  config: FilterConfig = {}
): Promise<number[]> {
  return withSpan("pr-filter.filterList", async (span) => {
    span.setAttribute("pr.count", prNumbers.length);

    const results = await Promise.all(
      prNumbers.map((pr) => shouldProcessPR(owner, repo, pr, config))
    );

    const filtered = prNumbers.filter((_, i) => results[i].shouldProcess);

    span.setAttribute("pr.filtered_count", filtered.length);
    log("info", "Filtered PR list", {
      total: prNumbers.length,
      passing: filtered.length,
    });

    return filtered;
  });
}

export default {
  shouldProcessPR,
  isClaaudeBranch,
  labelPRAsClaudeCreated,
  generateClaudeBranch,
  parseClaudeBranch,
  filterClaudePRs,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_LABEL,
};
