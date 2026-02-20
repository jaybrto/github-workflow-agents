const REPO_PATH = "/home/runner/repo";
const WORKTREES_PATH = "/home/runner/worktrees";

async function exec(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function fetchAll(): Promise<void> {
  const result = await exec("git", ["fetch", "--all", "--prune"], REPO_PATH);
  if (result.exitCode !== 0) {
    throw new Error(`git fetch failed: ${result.stderr}`);
  }
}

export async function worktreeExists(pr: number): Promise<boolean> {
  const path = getWorktreePath(pr);
  const result = await exec("git", ["worktree", "list"], REPO_PATH);

  return result.stdout.includes(path);
}

export function getWorktreePath(pr: number): string {
  return `${WORKTREES_PATH}/pr-${pr}`;
}

export function getIssueWorktreePath(issueNumber: number): string {
  return `${WORKTREES_PATH}/issue-${issueNumber}`;
}

export async function createWorktree(
  pr: number,
  branch: string
): Promise<string> {
  const path = getWorktreePath(pr);

  // Try origin/branch first, then local branch, then create from main
  let result = await exec(
    "git",
    ["worktree", "add", path, `origin/${branch}`],
    REPO_PATH
  );

  if (result.exitCode !== 0) {
    result = await exec("git", ["worktree", "add", path, branch], REPO_PATH);
  }

  if (result.exitCode !== 0) {
    result = await exec(
      "git",
      ["worktree", "add", "-b", `pr-${pr}`, path, "origin/main"],
      REPO_PATH
    );
  }

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  return path;
}

export async function updateWorktree(
  pr: number,
  branch: string
): Promise<void> {
  const path = getWorktreePath(pr);

  // Fetch and reset to origin
  await exec("git", ["fetch", "origin"], path);
  await exec("git", ["reset", "--hard", `origin/${branch}`], path);
}

export async function removeWorktree(pr: number): Promise<void> {
  const path = getWorktreePath(pr);
  const result = await exec(
    "git",
    ["worktree", "remove", path, "--force"],
    REPO_PATH
  );

  if (result.exitCode !== 0 && !result.stderr.includes("is not a working tree")) {
    throw new Error(`Failed to remove worktree: ${result.stderr}`);
  }
}

export async function listWorktrees(): Promise<string[]> {
  const result = await exec("git", ["worktree", "list", "--porcelain"], REPO_PATH);

  const worktrees: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktrees.push(line.replace("worktree ", ""));
    }
  }

  return worktrees;
}
