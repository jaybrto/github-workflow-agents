import Redis from "ioredis";
import type { PRSession, PRQuestion } from "./types.js";

const REDIS_HOST = process.env.REDIS_HOST || "redis.default.svc.cluster.local";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const TTL_SECONDS = 604800; // 7 days

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

// Key helpers
function prKey(repo: string, pr: number): string {
  return `pr:${repo}:${pr}`;
}

function prQuestionKey(repo: string, pr: number): string {
  return `pr:${repo}:${pr}:question`;
}

function podActivePrsKey(pod: string): string {
  return `pod:${pod}:active_prs`;
}

// Session management
export async function getSession(
  repo: string,
  pr: number
): Promise<PRSession | null> {
  const redis = getRedisClient();
  const data = await redis.hgetall(prKey(repo, pr));

  if (!data || !data.tmux_window) return null;

  return {
    tmuxWindow: parseInt(data.tmux_window, 10),
    podName: data.pod_name,
    worktreePath: data.worktree_path,
    createdAt: parseInt(data.created_at, 10),
    lastActivity: parseInt(data.last_activity || data.created_at, 10),
    status: data.status as PRSession["status"],
  };
}

export async function createSession(
  repo: string,
  pr: number,
  session: Omit<PRSession, "lastActivity">
): Promise<void> {
  const redis = getRedisClient();
  const key = prKey(repo, pr);

  await redis.hset(key, {
    tmux_window: session.tmuxWindow.toString(),
    pod_name: session.podName,
    worktree_path: session.worktreePath,
    created_at: session.createdAt.toString(),
    last_activity: session.createdAt.toString(),
    status: session.status,
  });

  await redis.expire(key, TTL_SECONDS);
  await redis.sadd(podActivePrsKey(session.podName), `${repo}:${pr}`);
}

export async function updateSessionStatus(
  repo: string,
  pr: number,
  status: PRSession["status"]
): Promise<void> {
  const redis = getRedisClient();
  await redis.hset(prKey(repo, pr), {
    status,
    last_activity: Date.now().toString(),
  });
}

export async function touchSession(repo: string, pr: number): Promise<void> {
  const redis = getRedisClient();
  await redis.hset(prKey(repo, pr), "last_activity", Date.now().toString());
  await redis.expire(prKey(repo, pr), TTL_SECONDS);
}

// Question management
export async function getQuestion(
  repo: string,
  pr: number
): Promise<PRQuestion | null> {
  const redis = getRedisClient();
  const data = await redis.hgetall(prQuestionKey(repo, pr));

  if (!data || !data.question) return null;

  return {
    question: data.question,
    askedAt: parseInt(data.asked_at, 10),
    answer: data.answer || undefined,
    answeredAt: data.answered_at
      ? parseInt(data.answered_at, 10)
      : undefined,
    answeredBy: data.answered_by || undefined,
  };
}

export async function storeQuestion(
  repo: string,
  pr: number,
  question: string
): Promise<void> {
  const redis = getRedisClient();
  await redis.hset(prQuestionKey(repo, pr), {
    question,
    asked_at: Date.now().toString(),
  });
  await redis.expire(prQuestionKey(repo, pr), TTL_SECONDS);
}

export async function storeAnswer(
  repo: string,
  pr: number,
  answer: string,
  answeredBy: string
): Promise<void> {
  const redis = getRedisClient();
  await redis.hset(prQuestionKey(repo, pr), {
    answer,
    answered_at: Date.now().toString(),
    answered_by: answeredBy,
  });
}

export async function clearQuestion(repo: string, pr: number): Promise<void> {
  const redis = getRedisClient();
  await redis.del(prQuestionKey(repo, pr));
}

// Cleanup helpers
export async function getAllPRKeys(): Promise<string[]> {
  const redis = getRedisClient();
  return redis.keys("pr:*");
}

export async function deletePRData(repo: string, pr: number): Promise<void> {
  const redis = getRedisClient();
  const session = await getSession(repo, pr);

  await redis.del(prKey(repo, pr));
  await redis.del(prQuestionKey(repo, pr));

  if (session) {
    await redis.srem(podActivePrsKey(session.podName), `${repo}:${pr}`);
  }
}

export async function getActivePRsForPod(pod: string): Promise<string[]> {
  const redis = getRedisClient();
  return redis.smembers(podActivePrsKey(pod));
}
