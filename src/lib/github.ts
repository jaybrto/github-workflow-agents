import { Octokit } from "@octokit/rest";

let octokit: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is required");
    }
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

export async function getPRDetails(
  owner: string,
  repo: string,
  pr: number
): Promise<{
  title: string;
  body: string | null;
  head: string;
  base: string;
  state: string;
}> {
  const client = getOctokit();
  const { data } = await client.pulls.get({
    owner,
    repo,
    pull_number: pr,
  });

  return {
    title: data.title,
    body: data.body,
    head: data.head.ref,
    base: data.base.ref,
    state: data.state,
  };
}

export async function getPRBranch(
  owner: string,
  repo: string,
  pr: number
): Promise<string> {
  const details = await getPRDetails(owner, repo, pr);
  return details.head;
}

export async function isPROpen(
  owner: string,
  repo: string,
  pr: number
): Promise<boolean> {
  try {
    const details = await getPRDetails(owner, repo, pr);
    return details.state === "open";
  } catch (error) {
    // PR doesn't exist or is not accessible
    return false;
  }
}

export async function postPRComment(
  owner: string,
  repo: string,
  pr: number,
  body: string
): Promise<void> {
  const client = getOctokit();
  await client.issues.createComment({
    owner,
    repo,
    issue_number: pr,
    body,
  });
}

export async function postQuestion(
  owner: string,
  repo: string,
  pr: number,
  question: string,
  context?: string
): Promise<void> {
  let body = `**Claude needs clarification:**\n\n${question}`;

  if (context) {
    body += `\n\n<details>\n<summary>Context</summary>\n\n${context}\n\n</details>`;
  }

  body += `\n\n---\n*Reply with \`@claude-answer: your answer\` to continue.*`;

  await postPRComment(owner, repo, pr, body);
}

export async function postWorkComplete(
  owner: string,
  repo: string,
  pr: number,
  summary: string,
  details?: string
): Promise<void> {
  let body = `**Claude completed work**\n\n${summary}`;

  if (details) {
    body += `\n\n<details>\n<summary>Details</summary>\n\n\`\`\`\n${details}\n\`\`\`\n\n</details>`;
  }

  await postPRComment(owner, repo, pr, body);
}

export async function postError(
  owner: string,
  repo: string,
  pr: number,
  error: string,
  details?: string
): Promise<void> {
  let body = `**Claude encountered an error**\n\n${error}`;

  if (details) {
    body += `\n\n<details>\n<summary>Error details</summary>\n\n\`\`\`\n${details}\n\`\`\`\n\n</details>`;
  }

  body += `\n\n*You can retry by commenting \`@claude\` on this PR.*`;

  await postPRComment(owner, repo, pr, body);
}
