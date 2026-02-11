/**
 * Background metrics exporter for session metrics.
 * Queries SQLite database every 60 seconds and exports metrics to OTEL.
 *
 * This approach avoids performance impact on the hot path by exporting
 * metrics asynchronously from the database.
 */

import { getDatabase, getConfig, setConfig } from "./db.js";
import { SessionMetrics } from "./telemetry.js";

// Export interval in milliseconds (60 seconds)
const EXPORT_INTERVAL_MS = 60_000;

// Batch size for large queries
const BATCH_SIZE = 100;

// Track export state
let exportInterval: Timer | null = null;
let isExporting = false;

/**
 * Export metrics from database to OTEL.
 * Queries for records since last export timestamp.
 */
export async function exportDatabaseMetrics(): Promise<void> {
  // Prevent concurrent exports
  if (isExporting) {
    console.log("[MetricsExporter] Skipping export - already in progress");
    return;
  }

  isExporting = true;
  const exportStartTime = Date.now();

  try {
    const db = getDatabase();

    // Get last export timestamp (in Unix epoch seconds)
    const lastExportStr = getConfig("metrics_last_export");
    const lastExport = lastExportStr ? parseInt(lastExportStr, 10) : 0;
    const now = Math.floor(Date.now() / 1000);

    console.log(`[MetricsExporter] Starting export (last: ${lastExport}, now: ${now})`);

    // Export completed sessions
    await exportCompletedSessions(db, lastExport);

    // Export tool calls
    await exportToolCalls(db, lastExport);

    // Export commits
    await exportCommits(db, lastExport);

    // Export questions answered
    await exportQuestionsAnswered(db, lastExport);

    // Export agent tasks
    await exportAgentTasks(db, lastExport);

    // Update last export timestamp
    setConfig("metrics_last_export", now.toString());

    const duration = Date.now() - exportStartTime;
    console.log(`[MetricsExporter] Export completed in ${duration}ms`);
  } catch (error) {
    console.error("[MetricsExporter] Export failed:", error);
  } finally {
    isExporting = false;
  }
}

/**
 * Export completed sessions (status = complete, error, or interrupted).
 */
async function exportCompletedSessions(db: any, sinceTimestamp: number): Promise<void> {
  try {
    let offset = 0;
    let totalExported = 0;

    while (true) {
      const sessions = db.query(`
        SELECT
          repo,
          status,
          type,
          started_at,
          completed_at,
          interrupted_at
        FROM sessions
        WHERE (completed_at > ? OR interrupted_at > ?)
          AND status IN ('complete', 'error', 'interrupted')
        ORDER BY COALESCE(completed_at, interrupted_at) ASC
        LIMIT ? OFFSET ?
      `).all(sinceTimestamp, sinceTimestamp, BATCH_SIZE, offset);

      if (sessions.length === 0) break;

      for (const session of sessions) {
        // Calculate duration in seconds
        const endTime = session.completed_at || session.interrupted_at;
        const duration = session.started_at && endTime
          ? endTime - session.started_at
          : 0;

        if (duration >= 0) {
          SessionMetrics.recordSessionComplete(
            session.repo,
            session.status,
            session.type,
            duration
          );
          totalExported++;
        }
      }

      offset += BATCH_SIZE;

      // Safety: break if we've processed too many (prevent infinite loop)
      if (offset > 10000) {
        console.warn("[MetricsExporter] Hit safety limit for sessions export");
        break;
      }
    }

    if (totalExported > 0) {
      console.log(`[MetricsExporter] Exported ${totalExported} completed sessions`);
    }
  } catch (error) {
    console.error("[MetricsExporter] Failed to export sessions:", error);
  }
}

/**
 * Export tool calls.
 */
async function exportToolCalls(db: any, sinceTimestamp: number): Promise<void> {
  try {
    let offset = 0;
    let totalExported = 0;

    while (true) {
      const toolCalls = db.query(`
        SELECT
          tool_name,
          session_id,
          success
        FROM tool_calls
        WHERE called_at > ?
        ORDER BY called_at ASC
        LIMIT ? OFFSET ?
      `).all(sinceTimestamp, BATCH_SIZE, offset);

      if (toolCalls.length === 0) break;

      for (const call of toolCalls) {
        SessionMetrics.recordToolCall(
          call.tool_name,
          call.session_id,
          call.success === 1
        );
        totalExported++;
      }

      offset += BATCH_SIZE;

      if (offset > 50000) {
        console.warn("[MetricsExporter] Hit safety limit for tool_calls export");
        break;
      }
    }

    if (totalExported > 0) {
      console.log(`[MetricsExporter] Exported ${totalExported} tool calls`);
    }
  } catch (error) {
    console.error("[MetricsExporter] Failed to export tool calls:", error);
  }
}

/**
 * Export commits created.
 */
async function exportCommits(db: any, sinceTimestamp: number): Promise<void> {
  try {
    let offset = 0;
    let totalExported = 0;

    while (true) {
      const commits = db.query(`
        SELECT
          c.session_id,
          s.repo
        FROM commits c
        JOIN sessions s ON c.session_id = s.id
        WHERE c.created_at > ?
        ORDER BY c.created_at ASC
        LIMIT ? OFFSET ?
      `).all(sinceTimestamp, BATCH_SIZE, offset);

      if (commits.length === 0) break;

      for (const commit of commits) {
        if (commit.repo) {
          SessionMetrics.recordCommitCreated(commit.repo, commit.session_id);
          totalExported++;
        }
      }

      offset += BATCH_SIZE;

      if (offset > 10000) {
        console.warn("[MetricsExporter] Hit safety limit for commits export");
        break;
      }
    }

    if (totalExported > 0) {
      console.log(`[MetricsExporter] Exported ${totalExported} commits`);
    }
  } catch (error) {
    console.error("[MetricsExporter] Failed to export commits:", error);
  }
}

/**
 * Export questions answered.
 */
async function exportQuestionsAnswered(db: any, sinceTimestamp: number): Promise<void> {
  try {
    let offset = 0;
    let totalExported = 0;

    while (true) {
      const questions = db.query(`
        SELECT
          q.asked_at,
          q.answered_at,
          s.repo
        FROM questions q
        JOIN sessions s ON q.session_id = s.id
        WHERE q.answered_at > ?
          AND q.status = 'answered'
        ORDER BY q.answered_at ASC
        LIMIT ? OFFSET ?
      `).all(sinceTimestamp, BATCH_SIZE, offset);

      if (questions.length === 0) break;

      for (const question of questions) {
        if (question.repo && question.asked_at && question.answered_at) {
          // Calculate latency in seconds
          const latency = question.answered_at - question.asked_at;

          if (latency >= 0) {
            SessionMetrics.recordQuestionAnswered(question.repo, latency);
            totalExported++;
          }
        }
      }

      offset += BATCH_SIZE;

      if (offset > 10000) {
        console.warn("[MetricsExporter] Hit safety limit for questions export");
        break;
      }
    }

    if (totalExported > 0) {
      console.log(`[MetricsExporter] Exported ${totalExported} questions answered`);
    }
  } catch (error) {
    console.error("[MetricsExporter] Failed to export questions:", error);
  }
}

/**
 * Export agent tasks.
 */
async function exportAgentTasks(db: any, sinceTimestamp: number): Promise<void> {
  try {
    let offset = 0;
    let totalExported = 0;

    while (true) {
      const tasks = db.query(`
        SELECT
          status,
          agent_type
        FROM agent_tasks
        WHERE completed_at > ?
          AND status IN ('completed', 'failed')
        ORDER BY completed_at ASC
        LIMIT ? OFFSET ?
      `).all(sinceTimestamp, BATCH_SIZE, offset);

      if (tasks.length === 0) break;

      for (const task of tasks) {
        SessionMetrics.recordAgentTaskComplete(
          task.status,
          task.agent_type
        );
        totalExported++;
      }

      offset += BATCH_SIZE;

      if (offset > 10000) {
        console.warn("[MetricsExporter] Hit safety limit for agent_tasks export");
        break;
      }
    }

    if (totalExported > 0) {
      console.log(`[MetricsExporter] Exported ${totalExported} agent tasks`);
    }
  } catch (error) {
    console.error("[MetricsExporter] Failed to export agent tasks:", error);
  }
}

/**
 * Start the background metrics exporter.
 * Call this on application startup.
 */
export function startMetricsExporter(): void {
  // Check if metrics export is disabled
  if (process.env.DISABLE_METRICS_EXPORT === "true") {
    console.log("[MetricsExporter] Metrics export disabled via DISABLE_METRICS_EXPORT");
    return;
  }

  if (exportInterval) {
    console.warn("[MetricsExporter] Already started");
    return;
  }

  console.log(`[MetricsExporter] Starting (interval: ${EXPORT_INTERVAL_MS}ms)`);

  // Run first export immediately
  exportDatabaseMetrics().catch((error) => {
    console.error("[MetricsExporter] Initial export failed:", error);
  });

  // Set up periodic export
  exportInterval = setInterval(() => {
    exportDatabaseMetrics().catch((error) => {
      console.error("[MetricsExporter] Periodic export failed:", error);
    });
  }, EXPORT_INTERVAL_MS);

  // Don't let the interval keep the process alive
  if (exportInterval.unref) {
    exportInterval.unref();
  }
}

/**
 * Stop the background metrics exporter.
 * Call this on graceful shutdown.
 */
export function stopMetricsExporter(): void {
  if (exportInterval) {
    console.log("[MetricsExporter] Stopping");
    clearInterval(exportInterval);
    exportInterval = null;
  }
}

// Register shutdown handler
process.on("SIGTERM", () => {
  stopMetricsExporter();
});

process.on("SIGINT", () => {
  stopMetricsExporter();
});
