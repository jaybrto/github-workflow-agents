#!/usr/bin/env bun
/**
 * Send Answer
 * Trigger: Blocked → Previous (any column)
 * Action: Send answer to blocked REPL session
 */

import { parseArgs } from "util";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";
import { restoreActor, persistSnapshot, getStateName, canTransition } from "../lib/state-machine.js";

interface SendAnswerArgs {
  issue: number;
  answer: string;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      answer: { type: "string" },
    },
    allowPositionals: true,
  });

  // Allow answer as positional argument for easier CLI use
  const answer = values.answer || positionals.join(" ");

  const args: SendAnswerArgs = {
    issue: parseInt(values.issue || "0", 10),
    answer: answer || "",
  };

  if (!args.issue || !args.answer) {
    console.error("Usage: gwa-send-answer --issue <number> --answer <answer>");
    console.error("   or: gwa-send-answer --issue <number> <answer text>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan("transition.send-answer", async (span) => {
      span.setAttribute("issue.number", args.issue);
      span.setAttribute("answer.length", args.answer.length);

      log("info", `Sending answer to blocked session for issue #${args.issue}`);

      await sendAnswer(args.issue, args.answer);
      success = true;
    });
  } catch (error) {
    log("error", "Failed to send answer", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function sendAnswer(issueNumber: number, answer: string): Promise<void> {
  const sessionId = `issue-${issueNumber}`;

  // 1. Initialize database and get session
  db.initDatabase();
  const session = db.getSession(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status !== "blocked") {
    log("warn", `Session ${sessionId} is not blocked (status: ${session.status}), proceeding anyway`);
  }

  // 2. Get pending question
  const pendingQuestion = db.getPendingQuestion(sessionId);
  const questionId = pendingQuestion?.id;
  const questionText = pendingQuestion?.question || "";

  if (!questionId) {
    log("warn", `No pending question found for session ${sessionId}`);
  } else {
    log("debug", `Answering question #${questionId}`);
  }

  // 3. Get tmux window
  const windowNum = session.tmux_window;
  if (!windowNum) {
    throw new Error(`No tmux window found for session ${sessionId}`);
  }

  // 4. Verify tmux window exists
  if (!(await tmux.windowExists(windowNum))) {
    throw new Error(`Tmux window ${windowNum} no longer exists`);
  }

  // 5. Update question record if exists
  if (questionId) {
    db.answerQuestion(questionId, answer, "human");
  }

  // 6. Transition XState: blocked -> previous state
  const actor = restoreActor(sessionId);
  if (actor) {
    const event = { type: "SEND_ANSWER" as const };
    if (!canTransition(actor, event)) {
      log("warn", `XState cannot SEND_ANSWER from ${getStateName(actor)}, proceeding anyway`);
    } else {
      actor.send(event);
      persistSnapshot(sessionId, actor.getSnapshot());
      log("debug", `XState transitioned to ${getStateName(actor)}`);
    }
  }

  // 7. Update session status
  db.updateSessionStatus(sessionId, "running");
  db.logActivity(sessionId, "question_answered", {
    question_id: questionId,
    answer_length: answer.length,
  }, "human");

  // 7. Format answer for Claude
  const formattedAnswer = `## Answer to Your Question

${questionText ? `**Your question was:** ${questionText}\n\n` : ""}**Answer:** ${answer}

Please continue with your work using this information.`;

  // 8. Send answer to REPL
  log("info", `Sending answer to window ${windowNum}`);

  if (formattedAnswer.length > 500) {
    // For long answers, use temp file
    const tempFile = `/tmp/gwa-answer-${sessionId}.md`;
    await Bun.write(tempFile, formattedAnswer);
    await tmux.sendCommand(windowNum, `Read ${tempFile}`);
  } else {
    // For short answers, send directly
    await tmux.sendKeys(windowNum, formattedAnswer);
    await tmux.sendKeys(windowNum, "Enter");
  }

  log("info", "Answer sent to session", {
    sessionId,
    window: windowNum,
    questionId: questionId || 0,
    answerLength: answer.length,
  });

  console.log(`
Answer sent:
  Session ID: ${sessionId}
  Tmux Window: ${windowNum}
  Question ID: ${questionId || "none"}
  Answer Length: ${answer.length} chars

Session is now running. Attach with:
  kubectl exec -it gwa-runner-0 -- tmux attach -t gwa-work:${windowNum}
`);
}

main();
