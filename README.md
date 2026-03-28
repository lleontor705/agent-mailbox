# agent-mailbox

Production-grade inter-agent messaging for multi-agent AI systems. SQLite-backed with zero external dependencies.

## Features

- **Embedded SQLite** — No broker, no server. Pure `bun:sqlite`.
- **Visibility timeouts** — SQS-style message claiming. Un-acked messages re-appear automatically.
- **Dead letter queue** — Messages that fail N times are moved to DLQ for inspection/replay.
- **Idempotency** — Deduplication keys prevent duplicate message processing.
- **Full-text search** — FTS5 with graceful LIKE fallback.
- **Rate limiting** — Per-agent, per-minute rate limits.
- **Message TTL** — Per-message expiration with automatic cleanup.
- **Typed payloads** — Full TypeScript types for all operations.
- **Priority ordering** — High/normal/low priority with priority-based inbox ordering.
- **Threading** — Conversation threads with participant tracking.
- **Broadcast** — Send to all agents at once.
- **Agent registry** — Dynamic agent discovery (auto-registered on first message).
- **Trace IDs** — Cross-workflow observability.
- **Metrics** — Queue depths, delivery times, per-agent stats.
- **OpenCode plugin** — Drop-in plugin for OpenCode CLI.
- **WAL mode** — Concurrent read/write for multi-agent workloads.

## Install

```bash
bun add agent-mailbox-core
```

## Quick Start

### Standalone (library)

```ts
import { Mailbox } from "agent-mailbox-core/lib";

const mailbox = new Mailbox({ dbPath: "./mailbox.db" });

// Send
const { messageId, threadId } = mailbox.send({
  from: "architect",
  to: "developer",
  subject: "API spec ready",
  body: "OpenAPI spec finalized. Proceed with implementation.",
  priority: "high",
  traceId: "workflow-42",
});

// Read inbox (with visibility timeout)
const messages = mailbox.readInbox({ agent: "developer" });

// Acknowledge (prevents re-delivery)
mailbox.acknowledge(messages[0].id, {
  from: "developer",
  body: "Got it, starting implementation.",
});

// Search
const { messages: results } = mailbox.search({ query: "API spec" });

// Metrics
console.log(mailbox.metrics());

mailbox.close();
```

### OpenCode Plugin (auto-install)

In your `opencode.json`:

```json
{
  "plugin": ["agent-mailbox-core@latest"]
}
```

Configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `AGENT_MAILBOX_DB` | `~/.agent-mailbox/mailbox.db` | Database path |
| `AGENT_MAILBOX_TTL` | `86400` | Default message TTL (seconds) |
| `AGENT_MAILBOX_VIS_TIMEOUT` | `300` | Visibility timeout (seconds) |
| `AGENT_MAILBOX_MAX_RETRIES` | `3` | Max retries before DLQ |
| `AGENT_MAILBOX_MAX_BODY` | `65536` | Max message body size (bytes) |
| `AGENT_MAILBOX_RATE_LIMIT` | `60` | Messages per agent per minute |

## API

### `new Mailbox(config?)`

Create a mailbox instance.

### `mailbox.send(opts)` — Send a message
### `mailbox.broadcast(opts)` — Send to all agents
### `mailbox.readInbox(opts)` — Read inbox (claims messages with visibility timeout)
### `mailbox.markRead(id)` — Mark as read
### `mailbox.acknowledge(id, response?)` — Acknowledge processing, optionally reply
### `mailbox.search(opts)` — Full-text search
### `mailbox.listThreads(agent, limit?)` — List conversation threads
### `mailbox.getThread(threadId)` — Get all messages in a thread
### `mailbox.request(opts)` — Send and wait for reply (exponential backoff)
### `mailbox.registerAgent(name, role?)` — Register agent in registry
### `mailbox.listAgents()` — List registered agents
### `mailbox.getDeadLetters(limit?)` — View dead letter queue
### `mailbox.replayDeadLetter(id)` — Re-send a dead letter
### `mailbox.metrics()` — Get queue metrics
### `mailbox.cleanup()` — Manual cleanup (runs automatically on interval)
### `mailbox.close()` — Close database and stop timers

## Architecture

```
Agent A ──msg_send──> SQLite ──msg_read_inbox──> Agent B
                        │
                   ┌────┴────┐
                   │  FTS5   │  ← Full-text search index
                   │  DLQ    │  ← Dead letter queue
                   │  Rate   │  ← Per-agent rate limits
                   │  Trace  │  ← Cross-workflow IDs
                   └─────────┘
```

## License

MIT
