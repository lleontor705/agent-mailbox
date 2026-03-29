<p align="center">
  <strong>agent-mailbox-core</strong><br>
  <em>Production-grade inter-agent messaging for multi-agent AI systems</em>
</p>

<p align="center">
  <a href="https://github.com/lleontor705/agent-mailbox/actions/workflows/ci.yml"><img src="https://github.com/lleontor705/agent-mailbox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/agent-mailbox-core"><img src="https://img.shields.io/npm/v/agent-mailbox-core" alt="npm" /></a>
  <a href="https://github.com/lleontor705/agent-mailbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
</p>

---

SQLite-backed inter-agent messaging with zero external dependencies. Visibility timeouts, dead letter queues, FTS5 search, rate limiting, typed payloads, threading, and broadcast — all powered by `bun:sqlite`.

## Install

```bash
bun add agent-mailbox-core
```

## Quick Start

### Library

```ts
import { Mailbox } from "agent-mailbox-core/lib";

const mailbox = new Mailbox({ dbPath: "./mailbox.db" });

// Send a message
const { messageId } = mailbox.send({
  from: "architect",
  to: "developer",
  subject: "API spec ready",
  body: "OpenAPI spec finalized. Proceed with implementation.",
  priority: "high",
});

// Read inbox (with visibility timeout)
const messages = mailbox.readInbox({ agent: "developer" });

// Acknowledge
mailbox.acknowledge(messages[0].id, {
  from: "developer",
  body: "Starting implementation.",
});

mailbox.close();
```

### OpenCode Plugin

```json
{
  "plugin": ["agent-mailbox-core@latest"]
}
```

## Features

| Feature | Description |
|---------|-------------|
| **Visibility timeouts** | SQS-style message claiming. Un-acked messages re-appear automatically |
| **Dead letter queue** | Messages that fail N times move to DLQ for inspection/replay |
| **Idempotency** | Deduplication keys prevent duplicate processing |
| **Full-text search** | FTS5 with graceful LIKE fallback |
| **Rate limiting** | Per-agent, per-minute limits |
| **Message TTL** | Per-message expiration with automatic cleanup |
| **Priority ordering** | High/normal/low with priority-based inbox |
| **Threading** | Conversation threads with participant tracking |
| **Broadcast** | Send to all agents at once |
| **Agent registry** | Dynamic agent discovery (auto-registered on first message) |
| **Trace IDs** | Cross-workflow observability |
| **Metrics** | Queue depths, delivery times, per-agent stats |
| **WAL mode** | Concurrent read/write for multi-agent workloads |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AGENT_MAILBOX_DB` | `~/.agent-mailbox/mailbox.db` | Database path |
| `AGENT_MAILBOX_TTL` | `86400` | Default message TTL (seconds) |
| `AGENT_MAILBOX_VIS_TIMEOUT` | `300` | Visibility timeout (seconds) |
| `AGENT_MAILBOX_MAX_RETRIES` | `3` | Max retries before DLQ |
| `AGENT_MAILBOX_MAX_BODY` | `65536` | Max message body size (bytes) |
| `AGENT_MAILBOX_RATE_LIMIT` | `60` | Messages per agent per minute |

## API

| Method | Description |
|--------|-------------|
| `send(opts)` | Send a message |
| `broadcast(opts)` | Send to all agents |
| `readInbox(opts)` | Read inbox (claims with visibility timeout) |
| `acknowledge(id, response?)` | Acknowledge processing, optionally reply |
| `search(opts)` | Full-text search |
| `listThreads(agent)` | List conversation threads |
| `getThread(threadId)` | Get all messages in a thread |
| `request(opts)` | Send and wait for reply (exponential backoff) |
| `registerAgent(name, role?)` | Register agent in registry |
| `listAgents()` | List registered agents |
| `getDeadLetters(limit?)` | View dead letter queue |
| `replayDeadLetter(id)` | Re-send a dead letter |
| `metrics()` | Get queue metrics |
| `cleanup()` | Manual cleanup |
| `close()` | Close database and stop timers |

## Architecture

```
Agent A --send--> SQLite --readInbox--> Agent B
                    |
              +-----+-----+
              | FTS5 index |
              | DLQ        |
              | Rate limits|
              | Trace IDs  |
              +------------+
```

## Development

```bash
bun install
bun test
bun run lint     # type check
```

## Contributing

1. Fork the repo
2. Create a feature branch from `develop`: `git checkout -b feat/my-feature develop`
3. Make your changes and add tests
4. Run `bun test` and `bun run lint`
5. Open a PR to `develop`

## License

MIT
