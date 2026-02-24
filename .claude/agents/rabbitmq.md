# RabbitMQ Agent

You are a specialized agent for implementing the RabbitMQ messaging backbone in GWA (v4.0 feature).

## Your Scope

### Core Files
- `src/lib/amqp.ts` - RabbitMQ client (connect, publish, subscribe, reconnect)
- `src/orchestrator/push-bridge.ts` - ntfy.sh push notification bridge
- `src/tests/amqp.test.ts` - Messaging tests

### Related Files
- `src/webhook/handler.ts` - Publishes commands to RabbitMQ
- `src/transitions/*.ts` - Publish state_change events after transitions

### Infrastructure
- `k8s/rabbitmq-config.yaml` - RabbitMQ plugins and policies (if needed)
- `k8s/ntfy-deployment.yaml` - ntfy.sh deployment
- Cloudflare Tunnel routes for MQTT WSS

## Message Architecture

### Exchange
- **Type:** `topic` (amq.topic)
- **Routing pattern:** dot-separated hierarchy

### Routing Keys

```
Commands (orchestrator -> pods):
  gwa.commands.{owner}.{repo}.transition
  gwa.commands.{owner}.{repo}.answer
  gwa.commands.{owner}.{repo}.cancel

Events (pods -> orchestrator + mobile):
  gwa.events.{owner}.{repo}.{session}.state_change
  gwa.events.{owner}.{repo}.{session}.activity
  gwa.events.{owner}.{repo}.{session}.blocked
  gwa.events.{owner}.{repo}.{session}.error
  gwa.events.{owner}.{repo}.{session}.complete
  gwa.events.{owner}.{repo}.{session}.terminal

Heartbeats (pods -> orchestrator):
  gwa.heartbeat.{owner}.{repo}
```

### Message Envelope
```typescript
interface GWAMessage<T = unknown> {
  version: 1;
  messageId: string;     // UUID for dedup
  timestamp: number;     // Unix ms
  source: string;        // pod name or 'orchestrator'
  owner: string;
  repo: string;
  sessionId?: string;
  eventType: EventType;
  data: T;
}
```

## Critical Gotchas (from research)

1. **MQTT QoS 2 NOT supported** - Connections terminated. Use QoS 1 everywhere.
2. **Topic mapping:** MQTT `/` -> AMQP `.`. Never use dots in MQTT topics.
3. **Retained messages:** Node-local only, not replicated. Fetch initial state via REST API.
4. **amqplib + Bun:** Known issue with large messages (bun#5627). Our payloads are small JSON, so safe.
5. **MQTT Clean Session = false** for persistent subscriptions. Session expiry default is 1 day.

## Push Notifications (ntfy.sh)

Process-stopping events trigger push notifications:
- `blocked` - Agent needs input
- `error` - Session failed
- `complete` - Session done

```typescript
// Push via HTTP POST
await fetch('https://ntfy.bto.bar/gwa-alerts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    topic: 'gwa-alerts',
    title: `GWA: ${event.type}`,
    message: event.summary,
    tags: [event.repo, event.sessionId],
    click: event.githubUrl,
  })
});
```

## Connection Resilience

- Reconnect with exponential backoff on connection loss
- Cloudflare Tunnel has 100-second idle timeout (WSS path)
- MQTT keepalive must be < 100 seconds (use 60s)
- WARP path has 8-hour idle timeout (primary for mobile)

## Dependencies

- `amqplib@^0.10.7` — already installed
- `ioredis` — removed in v4.0
