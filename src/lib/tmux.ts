import { tmux } from "node-tmux";

const SESSION_NAME = "gwa-work";

interface TmuxInstance {
  newSession(name: string, command?: string): Promise<void>;
  listSessions(): Promise<string[]>;
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
  renameSession(name: string, newName: string): Promise<void>;
  writeInput(name: string, text: string, newline?: boolean): Promise<void>;
}

let tmuxInstance: TmuxInstance | null = null;

async function getTmux(): Promise<TmuxInstance> {
  if (!tmuxInstance) {
    tmuxInstance = await tmux();
  }
  return tmuxInstance;
}

// Since node-tmux has limited window support, we'll use child_process for window operations
async function execTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux ${args.join(" ")} failed: ${stderr}`);
  }

  return stdout.trim();
}

export async function ensureSession(): Promise<void> {
  const tm = await getTmux();

  const hasSession = await tm.hasSession(SESSION_NAME);

  if (!hasSession) {
    // Create session with proper size using raw tmux command
    await execTmux([
      "new-session",
      "-d",
      "-s",
      SESSION_NAME,
      "-x",
      "200",
      "-y",
      "50",
      "-c",
      "/home/runner/repo",
    ]);

    // Rename the default window to "status"
    await execTmux(["rename-window", "-t", `${SESSION_NAME}:0`, "status"]);
  }
}

export async function getNextWindowIndex(): Promise<number> {
  try {
    const output = await execTmux([
      "list-windows",
      "-t",
      SESSION_NAME,
      "-F",
      "#{window_index}",
    ]);

    if (!output) return 1;

    const indices = output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));

    if (indices.length === 0) return 1;

    return Math.max(...indices) + 1;
  } catch {
    return 1;
  }
}

export async function createWindow(
  name: string,
  workingDir: string
): Promise<number> {
  const index = await getNextWindowIndex();

  await execTmux([
    "new-window",
    "-t",
    `${SESSION_NAME}:${index}`,
    "-n",
    name,
    "-c",
    workingDir,
  ]);

  return index;
}

export async function windowExists(windowIndex: number): Promise<boolean> {
  try {
    const output = await execTmux([
      "list-windows",
      "-t",
      SESSION_NAME,
      "-F",
      "#{window_index}",
    ]);

    return output.split("\n").includes(windowIndex.toString());
  } catch {
    return false;
  }
}

export async function sendKeys(
  windowIndex: number,
  keys: string
): Promise<void> {
  await execTmux(["send-keys", "-t", `${SESSION_NAME}:${windowIndex}`, keys]);
}

export async function sendCommand(
  windowIndex: number,
  command: string
): Promise<void> {
  await sendKeys(windowIndex, command);
  await sendKeys(windowIndex, "Enter");
}

export async function capturePane(
  windowIndex: number,
  lines: number = 50
): Promise<string> {
  return execTmux([
    "capture-pane",
    "-t",
    `${SESSION_NAME}:${windowIndex}`,
    "-p",
    "-S",
    `-${lines}`,
  ]);
}

export async function killWindow(windowIndex: number): Promise<void> {
  await execTmux(["kill-window", "-t", `${SESSION_NAME}:${windowIndex}`]);
}

export async function getWindowByName(
  name: string
): Promise<{ index: number } | null> {
  try {
    const output = await execTmux([
      "list-windows",
      "-t",
      SESSION_NAME,
      "-F",
      "#{window_index}:#{window_name}",
    ]);

    for (const line of output.split("\n")) {
      const [indexStr, windowName] = line.split(":");
      if (windowName === name) {
        return { index: parseInt(indexStr, 10) };
      }
    }

    return null;
  } catch {
    return null;
  }
}
