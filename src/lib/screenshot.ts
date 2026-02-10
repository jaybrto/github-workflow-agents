/**
 * Screenshot capture for tmux panes.
 * Converts ANSI terminal output to PNG images for GitHub PR comments.
 *
 * Pipeline: tmux capture-pane → aha (ANSI to HTML) → wkhtmltoimage (HTML to PNG)
 */
import { capturePane } from "./tmux";
import { log, withSpan } from "./telemetry";

export interface ScreenshotOptions {
  pod?: string; // Pod name (default from env)
  window: number; // Tmux window number
  maxSizeKB?: number; // Max size in KB (default: 70)
  width?: number; // Image width (default: 800)
  quality?: number; // Image quality 1-100 (default: 50)
  lines?: number; // Number of lines to capture (default: 50)
}

export interface ScreenshotResult {
  buffer: Buffer;
  sizeKB: number;
  wasCompressed: boolean;
}

const DEFAULT_MAX_SIZE_KB = 70;
const DEFAULT_WIDTH = 800;
const DEFAULT_QUALITY = 50;
const DEFAULT_LINES = 50;

/**
 * Check if a CLI tool is available.
 */
async function isToolAvailable(tool: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", tool], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Convert ANSI text with escape codes to HTML using aha.
 */
async function ansiToHtml(ansiText: string): Promise<string> {
  return withSpan("screenshot.ansiToHtml", async (span) => {
    const proc = Bun.spawn(["aha", "--no-header"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write ANSI text to stdin using Bun's FileSink API
    proc.stdin.write(ansiText);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      span.setAttribute("error.message", stderr);
      throw new Error(`aha failed with exit code ${exitCode}: ${stderr}`);
    }

    span.setAttribute("output.length", stdout.length);
    return stdout;
  });
}

/**
 * Convert HTML to PNG using wkhtmltoimage.
 */
async function htmlToPng(
  html: string,
  width: number,
  quality: number
): Promise<Buffer> {
  return withSpan("screenshot.htmlToPng", async (span) => {
    span.setAttribute("width", width);
    span.setAttribute("quality", quality);

    // Wrap HTML in a full document with styling for terminal appearance
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      background-color: #1e1e1e;
      color: #d4d4d4;
      font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.4;
      padding: 10px;
      margin: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    /* ANSI color overrides for dark background */
    .ansi-black { color: #1e1e1e; }
    .ansi-red { color: #f44747; }
    .ansi-green { color: #6a9955; }
    .ansi-yellow { color: #dcdcaa; }
    .ansi-blue { color: #569cd6; }
    .ansi-magenta { color: #c586c0; }
    .ansi-cyan { color: #4ec9b0; }
    .ansi-white { color: #d4d4d4; }
    .ansi-bright-black { color: #808080; }
    .ansi-bright-red { color: #f14c4c; }
    .ansi-bright-green { color: #89d185; }
    .ansi-bright-yellow { color: #e2e210; }
    .ansi-bright-blue { color: #75beff; }
    .ansi-bright-magenta { color: #e48cff; }
    .ansi-bright-cyan { color: #89ddff; }
    .ansi-bright-white { color: #ffffff; }
    .ansi-bold { font-weight: bold; }
    .ansi-underline { text-decoration: underline; }
  </style>
</head>
<body>
${html}
</body>
</html>`;

    // wkhtmltoimage reads from stdin when input is "-" and outputs to stdout when output is "-"
    const proc = Bun.spawn(
      [
        "wkhtmltoimage",
        "--quiet",
        "--quality",
        quality.toString(),
        "--width",
        width.toString(),
        "--disable-smart-width",
        "-", // Read from stdin
        "-", // Write to stdout
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Write HTML to stdin using Bun's FileSink API
    proc.stdin.write(fullHtml);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      span.setAttribute("error.message", stderr);
      throw new Error(`wkhtmltoimage failed with exit code ${exitCode}: ${stderr}`);
    }

    const buffer = Buffer.from(stdout);
    span.setAttribute("output.size", buffer.length);
    return buffer;
  });
}

/**
 * Capture a screenshot of a tmux pane.
 * Returns a PNG buffer suitable for embedding in GitHub comments.
 */
export async function captureScreenshot(
  options: ScreenshotOptions
): Promise<ScreenshotResult> {
  return withSpan("screenshot.capture", async (span) => {
    const {
      window,
      maxSizeKB = DEFAULT_MAX_SIZE_KB,
      width = DEFAULT_WIDTH,
      quality = DEFAULT_QUALITY,
      lines = DEFAULT_LINES,
    } = options;

    span.setAttribute("tmux.window", window);
    span.setAttribute("target.maxSizeKB", maxSizeKB);
    span.setAttribute("initial.width", width);
    span.setAttribute("initial.quality", quality);

    // Check if required tools are available
    const [hasAha, hasWkhtmltoimage] = await Promise.all([
      isToolAvailable("aha"),
      isToolAvailable("wkhtmltoimage"),
    ]);

    if (!hasAha) {
      throw new Error("aha is not installed. Install with: brew install aha");
    }

    if (!hasWkhtmltoimage) {
      throw new Error(
        "wkhtmltoimage is not installed. Install with: brew install wkhtmltopdf"
      );
    }

    // Capture tmux pane with ANSI escape codes
    log("debug", "Capturing tmux pane", { window, lines });

    // Use tmux capture-pane with escape codes (-e flag)
    const proc = Bun.spawn(
      [
        "tmux",
        "capture-pane",
        "-t",
        `gwa-work:${window}`,
        "-p",
        "-e", // Include escape sequences for colors
        "-S",
        `-${lines}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const ansiText = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tmux capture-pane failed: ${stderr}`);
    }

    span.setAttribute("ansi.length", ansiText.length);

    // Convert ANSI to HTML
    const html = await ansiToHtml(ansiText);

    // Try to generate PNG within size constraints
    let currentWidth = width;
    let currentQuality = quality;
    let buffer: Buffer;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;
      log("debug", "Generating PNG", {
        attempt: attempts,
        width: currentWidth,
        quality: currentQuality,
      });

      buffer = await htmlToPng(html, currentWidth, currentQuality);
      const sizeKB = buffer.length / 1024;

      span.setAttribute(`attempt.${attempts}.sizeKB`, sizeKB);

      if (sizeKB <= maxSizeKB) {
        log("info", "Screenshot captured successfully", {
          sizeKB: Math.round(sizeKB * 10) / 10,
          width: currentWidth,
          quality: currentQuality,
          attempts,
        });

        return {
          buffer,
          sizeKB: Math.round(sizeKB * 10) / 10,
          wasCompressed: attempts > 1,
        };
      }

      // Reduce quality first, then width
      if (currentQuality > 20) {
        currentQuality = Math.max(20, currentQuality - 15);
      } else if (currentWidth > 400) {
        currentWidth = Math.max(400, currentWidth - 100);
        currentQuality = quality; // Reset quality when reducing width
      } else {
        // Can't reduce further, return what we have
        log("warn", "Screenshot exceeds size limit after all attempts", {
          sizeKB: Math.round(sizeKB * 10) / 10,
          maxSizeKB,
        });

        return {
          buffer,
          sizeKB: Math.round(sizeKB * 10) / 10,
          wasCompressed: true,
        };
      }
    }

    // Should not reach here, but TypeScript needs this
    throw new Error("Failed to generate screenshot within size constraints");
  });
}

/**
 * Convert a PNG buffer to a base64 data URI for embedding in GitHub markdown.
 */
export function toBase64DataUri(buffer: Buffer): string {
  const base64 = buffer.toString("base64");
  return `data:image/png;base64,${base64}`;
}

/**
 * Generate markdown image tag from a screenshot buffer.
 */
export function toMarkdownImage(buffer: Buffer, alt: string = "Terminal screenshot"): string {
  const dataUri = toBase64DataUri(buffer);
  return `![${alt}](${dataUri})`;
}
