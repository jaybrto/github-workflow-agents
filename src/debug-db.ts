#!/usr/bin/env bun
import { parseArgs } from "util";
import * as db from "./lib/db.js";

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const repo = positionals[0];
  const outputJson = values.json || false;

  console.log("=== GWA SQLite Debug ===\n");

  try {
    // Initialize database
    db.initDatabase();
    const database = db.getDatabase();

    // Database integrity
    const integrity = database
      .query("PRAGMA integrity_check")
      .get() as { integrity_check: string };
    console.log(`Database integrity: ${integrity.integrity_check}\n`);

    // Active sessions
    const sessions = database
      .query(
        repo
          ? `SELECT * FROM sessions WHERE repo = ? ORDER BY created_at DESC LIMIT 20`
          : `SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20`
      )
      .all(...(repo ? [repo] : [])) as db.Session[];

    console.log(`Total sessions found: ${sessions.length}\n`);

    const activeSessions = sessions.filter((s) =>
      ["pending", "starting", "running", "blocked"].includes(s.status)
    );
    const completedSessions = sessions.filter((s) =>
      ["complete", "error", "interrupted"].includes(s.status)
    );

    console.log(`Active: ${activeSessions.length}`);
    console.log(`Completed: ${completedSessions.length}\n`);

    // Show session details
    if (sessions.length > 0) {
      console.log("=== Sessions ===\n");

      for (const session of sessions.slice(0, 10)) {
        if (outputJson) {
          console.log(JSON.stringify(session, null, 2));
        } else {
          console.log(`${session.github_type} #${session.github_number} (${session.repo})`);
          console.log(`  ID: ${session.id}`);
          console.log(`  Status: ${session.status}`);
          console.log(`  Type: ${session.type}`);
          console.log(`  Window: ${session.tmux_window ?? "none"}`);
          console.log(`  Path: ${session.worktree_path ?? "none"}`);
          console.log(`  Created: ${session.created_at ? new Date(session.created_at * 1000).toISOString() : "unknown"}`);
          console.log(`  Last Activity: ${session.last_activity_at ? new Date(session.last_activity_at * 1000).toISOString() : "unknown"}`);
          console.log();
        }
      }

      if (sessions.length > 10) {
        console.log(`... and ${sessions.length - 10} more sessions\n`);
      }
    }

    // Show pending questions
    const questions = database
      .query(`SELECT q.*, s.repo, s.github_number FROM questions q JOIN sessions s ON q.session_id = s.id WHERE q.status IN ('pending', 'posted') ORDER BY q.asked_at DESC LIMIT 10`)
      .all() as Array<db.Question & { repo: string; github_number: number }>;

    if (questions.length > 0) {
      console.log("=== Pending Questions ===\n");

      for (const q of questions) {
        if (outputJson) {
          console.log(JSON.stringify(q, null, 2));
        } else {
          console.log(`#${q.github_number} (${(q as any).repo})`);
          console.log(`  Question: ${q.question.substring(0, 100)}...`);
          console.log(`  Status: ${q.status}`);
          console.log(`  Asked: ${new Date(q.asked_at * 1000).toISOString()}`);
          if (q.answer) {
            console.log(`  Answer: ${q.answer.substring(0, 100)}...`);
            console.log(`  Answered by: ${q.answered_by}`);
          }
          console.log();
        }
      }
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    db.closeDatabase();
  }
}

main();
