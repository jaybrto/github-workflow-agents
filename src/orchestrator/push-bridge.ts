/**
 * Push Bridge — ntfy.sh integration
 *
 * Subscribes to AMQP events (blocked, error, complete) and sends
 * push notifications via ntfy.sh with debounce and rate limiting.
 */

import type { AmqpMessage, PushNotification } from "../shared/types.js";

const NTFY_URL = process.env.NTFY_URL || "https://ntfy.bto.bar/gwa";

// Rate limiting configuration
const PER_SESSION_DEBOUNCE_MS = 30_000;   // 30 seconds
const PER_SESSION_COOLDOWN_MS = 5 * 60_000; // 5 minutes
const GLOBAL_RATE_LIMIT = 5;               // notifications per minute
const GLOBAL_RATE_WINDOW_MS = 60_000;      // 1 minute window

/** Internal tracking for rate limits */
interface SessionNotificationState {
  lastNotifiedAt: number;
  lastDebouncedAt: number;
}

export class PushBridge {
  private sessionState = new Map<string, SessionNotificationState>();
  private globalTimestamps: number[] = [];
  private ntfyUrl: string;

  constructor(ntfyUrl?: string) {
    this.ntfyUrl = ntfyUrl || NTFY_URL;
  }

  /** Process an AMQP event and potentially send a notification */
  async handleEvent(message: AmqpMessage): Promise<boolean> {
    const { routingKey, payload, sessionId, timestamp } = message;

    // Only notify for blocked, error, and complete events
    const eventType = this.extractEventType(routingKey);
    if (!eventType) return false;

    const notification = this.buildNotification(eventType, sessionId, payload, timestamp);
    if (!notification) return false;

    // Check per-session debounce (30s)
    const state = this.sessionState.get(sessionId);
    if (state && timestamp - state.lastDebouncedAt < PER_SESSION_DEBOUNCE_MS) {
      return false;
    }

    // Check per-session cooldown (5 min)
    if (state && timestamp - state.lastNotifiedAt < PER_SESSION_COOLDOWN_MS) {
      // Update debounce tracker even if we don't send
      if (state) state.lastDebouncedAt = timestamp;
      return false;
    }

    // Check global rate limit (5/min)
    this.pruneGlobalTimestamps(timestamp);
    if (this.globalTimestamps.length >= GLOBAL_RATE_LIMIT) {
      return false;
    }

    // Send the notification
    const sent = await this.sendNotification(notification);
    if (sent) {
      this.globalTimestamps.push(timestamp);
      this.sessionState.set(sessionId, {
        lastNotifiedAt: timestamp,
        lastDebouncedAt: timestamp,
      });
    }
    return sent;
  }

  private extractEventType(routingKey: string): PushNotification["type"] | null {
    if (routingKey.includes("blocked") || routingKey.includes("pause_for_question")) {
      return "blocked";
    }
    if (routingKey.includes("error")) return "error";
    if (routingKey.includes("complete") || routingKey.includes("deploy_and_cleanup")) {
      return "complete";
    }
    return null;
  }

  private buildNotification(
    type: PushNotification["type"],
    sessionId: string,
    payload: unknown,
    _timestamp: number,
  ): PushNotification | null {
    const data = payload as Record<string, unknown>;
    const repo = (data.repo as string) || "";
    const issueNumber = (data.issueNumber as number) || 0;
    const label = repo && issueNumber ? `${repo}#${issueNumber}` : sessionId;

    switch (type) {
      case "blocked":
        return {
          type: "blocked",
          title: `Session blocked: ${label}`,
          body: (data.question as string) || "Session needs human input",
          sessionId,
          priority: 4,
          tags: ["question", "gwa"],
        };
      case "error":
        return {
          type: "error",
          title: `Session error: ${label}`,
          body: (data.error as string) || "Session encountered an error",
          sessionId,
          priority: 5,
          tags: ["error", "gwa"],
        };
      case "complete":
        return {
          type: "complete",
          title: `Session complete: ${label}`,
          body: (data.summary as string) || "Session finished successfully",
          sessionId,
          priority: 3,
          tags: ["done", "gwa"],
        };
      default:
        return null;
    }
  }

  private async sendNotification(notification: PushNotification): Promise<boolean> {
    try {
      const priorityMap: Record<number, string> = {
        1: "min",
        2: "low",
        3: "default",
        4: "high",
        5: "urgent",
      };

      const response = await fetch(this.ntfyUrl, {
        method: "POST",
        headers: {
          "Title": notification.title,
          "Priority": priorityMap[notification.priority] || "default",
          "Tags": notification.tags?.join(",") || "",
        },
        body: notification.body,
      });

      if (!response.ok) {
        console.error(`[PushBridge] ntfy.sh responded with ${response.status}`);
        return false;
      }

      console.log(`[PushBridge] Sent ${notification.type} notification for ${notification.sessionId}`);
      return true;
    } catch (error) {
      console.error(`[PushBridge] Failed to send notification:`, error);
      return false;
    }
  }

  private pruneGlobalTimestamps(now: number): void {
    this.globalTimestamps = this.globalTimestamps.filter(
      (ts) => now - ts < GLOBAL_RATE_WINDOW_MS,
    );
  }

  /**
   * Send a notification directly, bypassing AMQP event routing.
   * Used by the EnvironmentProvisioner for auth alerts.
   */
  async sendDirect(notification: PushNotification): Promise<boolean> {
    return this.sendNotification(notification);
  }

  /** For testing — reset all state */
  reset(): void {
    this.sessionState.clear();
    this.globalTimestamps = [];
  }
}
