/**
 * Core Mailbox class — the main API for agent-mailbox
 */

import { Database } from "bun:sqlite";
import { initDatabase } from "./database.js";
import type {
  MailboxConfig,
  ResolvedConfig,
  Message,
  SendOptions,
  SendResult,
  InboxOptions,
  SearchOptions,
  Thread,
  DeadLetter,
  MailboxMetrics,
  AgentInfo,
  Priority,
} from "./types.js";

const DEFAULT_CONFIG: ResolvedConfig = {
  dbPath: ":memory:",
  defaultTTL: 86400,
  visibilityTimeout: 300,
  maxRetries: 3,
  maxBodySize: 65536,
  rateLimitPerMinute: 60,
  walMode: true,
  cleanupInterval: 300,
};

function resolveConfig(config?: MailboxConfig): ResolvedConfig {
  return { ...DEFAULT_CONFIG, ...config };
}

function generateThreadId(): string {
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateIdempotencyKey(): string {
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Mailbox {
  readonly db: Database;
  readonly config: ResolvedConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Prepared statements
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(config?: MailboxConfig) {
    this.config = resolveConfig(config);
    this.db = initDatabase(this.config);
    this.stmts = this.prepareStatements();

    if (this.config.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(
        () => this.cleanup(),
        this.config.cleanupInterval * 1000
      );
    }
  }

  private prepareStatements() {
    return {
      insertMessage: this.db.prepare(`
        INSERT INTO messages (from_agent, to_agent, subject, body, thread_id, priority, ttl_seconds, idempotency_key, trace_id, session_id, expires_at)
        VALUES ($from, $to, $subject, $body, $thread_id, $priority, $ttl, $idem_key, $trace_id, $session_id, datetime('now', '+' || $ttl || ' seconds'))
      `),

      insertThread: this.db.prepare(`
        INSERT OR IGNORE INTO threads (id, subject, participants) VALUES ($id, $subject, $participants)
      `),

      updateThreadTimestamp: this.db.prepare(`
        UPDATE threads SET last_message_at = datetime('now') WHERE id = $id
      `),

      // Visibility timeout: only fetch messages that are visible (visible_after IS NULL or past)
      getInbox: this.db.prepare(`
        SELECT * FROM messages
        WHERE (to_agent = $agent OR to_agent = 'broadcast')
        AND from_agent != $agent
        AND status IN ('pending', 'delivered')
        AND (visible_after IS NULL OR visible_after <= datetime('now'))
        AND expires_at > datetime('now')
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
          created_at DESC
        LIMIT $limit
      `),

      getInboxIncludeRead: this.db.prepare(`
        SELECT * FROM messages
        WHERE (to_agent = $agent OR to_agent = 'broadcast')
        AND from_agent != $agent
        AND status NOT IN ('dead', 'expired')
        AND expires_at > datetime('now')
        ORDER BY created_at DESC
        LIMIT $limit
      `),

      // Claim: set visibility timeout + increment receive_count
      claimMessage: this.db.prepare(`
        UPDATE messages
        SET status = 'delivered',
            receive_count = receive_count + 1,
            visible_after = datetime('now', '+' || $timeout || ' seconds')
        WHERE id = $id
      `),

      markRead: this.db.prepare(`
        UPDATE messages SET status = 'read', read_at = datetime('now'), visible_after = NULL WHERE id = $id
      `),

      markAcked: this.db.prepare(`
        UPDATE messages SET status = 'acked', ack_at = datetime('now'), visible_after = NULL WHERE id = $id
      `),

      getMessage: this.db.prepare(`SELECT * FROM messages WHERE id = $id`),

      searchFTS: this.db.prepare(`
        SELECT m.* FROM messages m
        JOIN messages_fts fts ON m.id = fts.rowid
        WHERE messages_fts MATCH $query
        AND m.expires_at > datetime('now')
        ORDER BY m.created_at DESC
        LIMIT $limit
      `),

      searchLIKE: this.db.prepare(`
        SELECT * FROM messages
        WHERE (subject LIKE $q OR body LIKE $q)
        AND expires_at > datetime('now')
        ORDER BY created_at DESC
        LIMIT $limit
      `),

      listThreads: this.db.prepare(`
        SELECT t.*,
          COUNT(m.id) as message_count,
          SUM(CASE WHEN m.status IN ('pending', 'delivered') AND (m.to_agent = $agent OR m.to_agent = 'broadcast') THEN 1 ELSE 0 END) as unread_count
        FROM threads t
        LEFT JOIN messages m ON m.thread_id = t.id
        GROUP BY t.id
        ORDER BY t.last_message_at DESC
        LIMIT $limit
      `),

      getThreadMessages: this.db.prepare(`
        SELECT * FROM messages WHERE thread_id = $thread_id ORDER BY created_at ASC
      `),

      getReply: this.db.prepare(`
        SELECT * FROM messages
        WHERE thread_id = $thread_id AND from_agent = $from AND to_agent = $to AND id > $after_id
        ORDER BY created_at ASC LIMIT 1
      `),

      // Dead letter operations
      moveToDLQ: this.db.prepare(`
        INSERT INTO dead_letters (original_message_id, from_agent, to_agent, subject, body, thread_id, reason)
        SELECT id, from_agent, to_agent, subject, body, thread_id, $reason
        FROM messages WHERE id = $id
      `),

      markDead: this.db.prepare(`
        UPDATE messages SET status = 'dead' WHERE id = $id
      `),

      getDeadLetters: this.db.prepare(`
        SELECT * FROM dead_letters ORDER BY moved_at DESC LIMIT $limit
      `),

      replayDeadLetter: this.db.prepare(`
        SELECT * FROM dead_letters WHERE id = $id
      `),

      deleteDeadLetter: this.db.prepare(`
        DELETE FROM dead_letters WHERE id = $id
      `),

      // Rate limiting
      checkRate: this.db.prepare(`
        SELECT message_count FROM rate_limits
        WHERE agent = $agent AND window_start = $window
      `),

      upsertRate: this.db.prepare(`
        INSERT INTO rate_limits (agent, window_start, message_count)
        VALUES ($agent, $window, 1)
        ON CONFLICT(agent, window_start)
        DO UPDATE SET message_count = message_count + 1
      `),

      // Agent registry
      upsertAgent: this.db.prepare(`
        INSERT INTO agent_registry (name, role, last_active)
        VALUES ($name, $role, datetime('now'))
        ON CONFLICT(name)
        DO UPDATE SET role = COALESCE($role, role), last_active = datetime('now')
      `),

      listAgents: this.db.prepare(`
        SELECT ar.name, ar.role, ar.last_active,
          (SELECT COUNT(*) FROM messages WHERE from_agent = ar.name) as message_count
        FROM agent_registry ar
        ORDER BY ar.last_active DESC
      `),

      // Cleanup
      expireMessages: this.db.prepare(`
        UPDATE messages SET status = 'expired' WHERE expires_at <= datetime('now') AND status NOT IN ('acked', 'expired', 'dead')
      `),

      requeueTimedOut: this.db.prepare(`
        UPDATE messages SET status = 'pending', visible_after = NULL
        WHERE status = 'delivered'
        AND visible_after IS NOT NULL
        AND visible_after <= datetime('now')
        AND receive_count < $max_retries
      `),

      moveExhaustedToDLQ: this.db.prepare(`
        SELECT id FROM messages
        WHERE status = 'delivered'
        AND visible_after IS NOT NULL
        AND visible_after <= datetime('now')
        AND receive_count >= $max_retries
      `),

      cleanRateLimits: this.db.prepare(`
        DELETE FROM rate_limits WHERE window_start < $cutoff
      `),

      // Metrics
      countByStatus: this.db.prepare(`
        SELECT status, COUNT(*) as cnt FROM messages GROUP BY status
      `),

      countDeadLetters: this.db.prepare(`
        SELECT COUNT(*) as cnt FROM dead_letters
      `),

      countActiveThreads: this.db.prepare(`
        SELECT COUNT(*) as cnt FROM threads WHERE last_message_at > datetime('now', '-1 hour')
      `),

      messagesPerAgent: this.db.prepare(`
        SELECT from_agent, COUNT(*) as cnt FROM messages GROUP BY from_agent ORDER BY cnt DESC
      `),

      avgDeliveryTime: this.db.prepare(`
        SELECT AVG((julianday(read_at) - julianday(created_at)) * 86400000) as avg_ms
        FROM messages WHERE read_at IS NOT NULL
      `),

      // Idempotency check
      checkIdempotency: this.db.prepare(`
        SELECT id, thread_id FROM messages WHERE idempotency_key = $key
      `),
    };
  }

  // ─── Core Operations ─────────────────────────────────────────────

  /** Send a message to an agent */
  send(opts: SendOptions): SendResult {
    // Validate body size
    if (Buffer.byteLength(opts.body, "utf-8") > this.config.maxBodySize) {
      throw new Error(`Message body exceeds max size of ${this.config.maxBodySize} bytes`);
    }

    // Check rate limit
    this.checkRateLimit(opts.from);

    // Idempotency check
    if (opts.idempotencyKey) {
      const existing = this.stmts.checkIdempotency.get({ $key: opts.idempotencyKey }) as { id: number; thread_id: string } | null;
      if (existing) {
        return { messageId: existing.id, threadId: existing.thread_id, idempotencyKey: opts.idempotencyKey };
      }
    }

    const threadId = opts.threadId ?? generateThreadId();
    const ttl = opts.ttlSeconds ?? this.config.defaultTTL;

    // Create/update thread
    this.stmts.insertThread.run({
      $id: threadId,
      $subject: opts.subject,
      $participants: JSON.stringify([opts.from, opts.to]),
    });
    this.stmts.updateThreadTimestamp.run({ $id: threadId });

    // Insert message
    const result = this.stmts.insertMessage.run({
      $from: opts.from,
      $to: opts.to,
      $subject: opts.subject,
      $body: opts.body,
      $thread_id: threadId,
      $priority: opts.priority ?? "normal",
      $ttl: ttl,
      $idem_key: opts.idempotencyKey ?? null,
      $trace_id: opts.traceId ?? null,
      $session_id: opts.sessionId ?? "",
    });

    // Update agent registry
    this.stmts.upsertAgent.run({ $name: opts.from, $role: null });

    return {
      messageId: Number(result.lastInsertRowid),
      threadId,
      idempotencyKey: opts.idempotencyKey ?? null,
    };
  }

  /** Broadcast a message to all agents */
  broadcast(opts: Omit<SendOptions, "to">): SendResult {
    return this.send({ ...opts, to: "broadcast" });
  }

  /** Read inbox with visibility timeout */
  readInbox(opts: InboxOptions): Message[] {
    const limit = opts.limit ?? 20;

    if (opts.includeRead) {
      return this.stmts.getInboxIncludeRead.all({ $agent: opts.agent, $limit: limit }) as Message[];
    }

    const rows = this.stmts.getInbox.all({ $agent: opts.agent, $limit: limit }) as Message[];

    // Claim messages with visibility timeout
    for (const row of rows) {
      this.stmts.claimMessage.run({
        $id: row.id,
        $timeout: this.config.visibilityTimeout,
      });
    }

    return rows;
  }

  /** Mark a message as read (clears visibility timeout) */
  markRead(messageId: number): void {
    this.stmts.markRead.run({ $id: messageId });
  }

  /** Acknowledge a message (confirms processing complete) */
  acknowledge(messageId: number, response?: { from: string; body: string; sessionId?: string }): SendResult | null {
    this.stmts.markAcked.run({ $id: messageId });

    if (response) {
      const original = this.stmts.getMessage.get({ $id: messageId }) as Message | null;
      if (original) {
        return this.send({
          from: response.from,
          to: original.from_agent,
          subject: `Re: ${original.subject}`,
          body: response.body,
          threadId: original.thread_id,
          priority: "normal",
          sessionId: response.sessionId,
        });
      }
    }
    return null;
  }

  /** Search messages using FTS5 with LIKE fallback */
  search(opts: SearchOptions): { messages: Message[]; usedFallback: boolean } {
    const limit = opts.limit ?? 10;

    try {
      const rows = this.stmts.searchFTS.all({ $query: opts.query, $limit: limit }) as Message[];
      return { messages: rows, usedFallback: false };
    } catch {
      const rows = this.stmts.searchLIKE.all({ $q: `%${opts.query}%`, $limit: limit }) as Message[];
      return { messages: rows, usedFallback: true };
    }
  }

  /** List conversation threads */
  listThreads(agent: string, limit = 10): Thread[] {
    return this.stmts.listThreads.all({ $agent: agent, $limit: limit }) as Thread[];
  }

  /** Get all messages in a thread */
  getThread(threadId: string): Message[] {
    return this.stmts.getThreadMessages.all({ $thread_id: threadId }) as Message[];
  }

  /** Send a request and poll for reply with exponential backoff */
  async request(
    opts: SendOptions & { timeoutMs?: number }
  ): Promise<{ reply: Message } | { timeout: true; messageId: number; threadId: string }> {
    const timeout = opts.timeoutMs ?? 120_000;
    const { messageId, threadId } = this.send({
      ...opts,
      priority: "high",
      body: opts.body + "\n\n---\nREPLY REQUESTED — sender is waiting.",
    });

    const startTime = Date.now();
    let delay = 500; // Start at 500ms, exponential backoff

    while (Date.now() - startTime < timeout) {
      const reply = this.stmts.getReply.get({
        $thread_id: threadId,
        $from: opts.to,
        $to: opts.from,
        $after_id: messageId,
      }) as Message | null;

      if (reply) {
        this.markRead(reply.id);
        return { reply };
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 10_000); // Cap at 10s
    }

    return { timeout: true, messageId, threadId };
  }

  // ─── Agent Registry ──────────────────────────────────────────────

  /** Register an agent (upsert) */
  registerAgent(name: string, role?: string): void {
    this.stmts.upsertAgent.run({ $name: name, $role: role ?? null });
  }

  /** List all registered agents */
  listAgents(): AgentInfo[] {
    return this.stmts.listAgents.all() as AgentInfo[];
  }

  // ─── Dead Letter Queue ───────────────────────────────────────────

  /** Get messages in the dead letter queue */
  getDeadLetters(limit = 20): DeadLetter[] {
    return this.stmts.getDeadLetters.all({ $limit: limit }) as DeadLetter[];
  }

  /** Replay a dead letter (re-send the original message) */
  replayDeadLetter(dlqId: number): SendResult | null {
    const dl = this.stmts.replayDeadLetter.get({ $id: dlqId }) as DeadLetter | null;
    if (!dl) return null;

    const result = this.send({
      from: dl.from_agent,
      to: dl.to_agent,
      subject: dl.subject,
      body: dl.body,
      threadId: dl.thread_id,
    });

    this.stmts.deleteDeadLetter.run({ $id: dlqId });
    return result;
  }

  // ─── Metrics ─────────────────────────────────────────────────────

  /** Get mailbox metrics snapshot */
  metrics(): MailboxMetrics {
    const statusCounts = this.stmts.countByStatus.all() as { status: string; cnt: number }[];
    const statusMap: Record<string, number> = {};
    let total = 0;
    for (const row of statusCounts) {
      statusMap[row.status] = row.cnt;
      total += row.cnt;
    }

    const dlCount = (this.stmts.countDeadLetters.get() as { cnt: number }).cnt;
    const threadCount = (this.stmts.countActiveThreads.get() as { cnt: number }).cnt;
    const perAgent = this.stmts.messagesPerAgent.all() as { from_agent: string; cnt: number }[];
    const avgDel = this.stmts.avgDeliveryTime.get() as { avg_ms: number | null };

    return {
      totalMessages: total,
      pendingMessages: statusMap["pending"] ?? 0,
      deliveredMessages: statusMap["delivered"] ?? 0,
      deadLetters: dlCount,
      activeThreads: threadCount,
      messagesPerAgent: Object.fromEntries(perAgent.map((r) => [r.from_agent, r.cnt])),
      avgDeliveryTimeMs: avgDel.avg_ms,
    };
  }

  // ─── Maintenance ─────────────────────────────────────────────────

  /** Run cleanup: expire messages, requeue timed-out, move exhausted to DLQ */
  cleanup(): { expired: number; requeued: number; deadLettered: number } {
    // Expire old messages
    const expired = this.stmts.expireMessages.run().changes;

    // Requeue messages that timed out (visibility expired) but have retries left
    const requeued = this.stmts.requeueTimedOut.run({ $max_retries: this.config.maxRetries }).changes;

    // Move exhausted messages to DLQ
    const exhausted = this.stmts.moveExhaustedToDLQ.all({ $max_retries: this.config.maxRetries }) as { id: number }[];
    for (const { id } of exhausted) {
      this.stmts.moveToDLQ.run({ $id: id, $reason: `Max retries (${this.config.maxRetries}) exceeded` });
      this.stmts.markDead.run({ $id: id });
    }

    // Clean old rate limit entries
    const cutoff = new Date(Date.now() - 120_000).toISOString().slice(0, 16);
    this.stmts.cleanRateLimits.run({ $cutoff: cutoff });

    return { expired, requeued, deadLettered: exhausted.length };
  }

  /** Close the database and stop cleanup timer */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.db.close();
  }

  // ─── Private ─────────────────────────────────────────────────────

  private checkRateLimit(agent: string): void {
    const window = new Date().toISOString().slice(0, 16); // Per-minute window
    const current = this.stmts.checkRate.get({ $agent: agent, $window: window }) as { message_count: number } | null;

    if (current && current.message_count >= this.config.rateLimitPerMinute) {
      throw new Error(`Rate limit exceeded for agent '${agent}': ${this.config.rateLimitPerMinute}/min`);
    }

    this.stmts.upsertRate.run({ $agent: agent, $window: window });
  }
}
