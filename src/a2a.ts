/**
 * A2A Protocol adapter for agent-mailbox
 *
 * Provides bidirectional translation between A2A Protocol messages
 * and agent-mailbox's native message format, enabling seamless
 * interoperation with A2A-compatible agents.
 *
 * @example
 * ```ts
 * import { Mailbox } from "agent-mailbox-core/lib";
 * import { A2AAdapter } from "agent-mailbox-core/lib/a2a";
 *
 * const mailbox = new Mailbox({ dbPath: "./mailbox.db" });
 * const adapter = new A2AAdapter(mailbox, { agentId: "my-agent", agentName: "My Agent" });
 *
 * // Register as A2A agent
 * adapter.register();
 *
 * // Send A2A message
 * await adapter.send({
 *   type: "request",
 *   to: ["other-agent"],
 *   topic: "task-update",
 *   payload: { taskId: 123, status: "done" },
 * });
 *
 * // Listen for A2A messages
 * adapter.onMessage((msg) => {
 *   console.log("Received:", msg);
 * });
 * ```
 */

import type { Mailbox } from "./mailbox.js";
import type { Message, SendOptions } from "./types.js";

// ─── A2A Types ──────────────────────────────────────────────────────

/** A2A message types */
export type A2AMessageType = "request" | "response" | "notify" | "event" | "stream";

/** A2A Protocol message */
export interface A2AMessage {
  /** Unique message identifier */
  id: string;
  /** Message type */
  type: A2AMessageType;
  /** Sender agent ID */
  from: string;
  /** Recipient agent IDs (empty = broadcast) */
  to: string[];
  /** Message topic/categorization */
  topic?: string;
  /** Message headers */
  headers?: Record<string, unknown>;
  /** Message creation timestamp */
  timestamp: string;
  /** Message payload (any JSON-serializable type) */
  payload: unknown;
  /** Error information (for responses) */
  error?: A2AError;
  /** Session identifier for context preservation */
  session_id?: string;
  /** Distributed tracing identifier */
  trace_id?: string;
  /** Original message ID (for replies) */
  reply_to?: string;
  /** Message sequence number */
  sequence?: number;
}

/** A2A error format */
export interface A2AError {
  code: string;
  message: string;
  details?: unknown;
}

/** A2A agent representation */
export interface A2AAgent {
  id: string;
  name: string;
  version?: string;
  capabilities: A2ACapability[];
  metadata?: Record<string, unknown>;
  endpoint?: string;
  status: A2AAgentStatus;
  last_seen: string;
}

/** A2A agent capability */
export interface A2ACapability {
  name: string;
  version?: string;
  description?: string;
  topics?: string[];
}

/** A2A agent status */
export type A2AAgentStatus = "active" | "inactive" | "error" | "unknown";

/** A2A session */
export interface A2ASession {
  id: string;
  initiator: string;
  participants: string[];
  started_at: string;
  ended_at?: string;
  metadata?: Record<string, unknown>;
}

/** A2A message acknowledgment */
export interface A2AAcknowledgment {
  message_id: string;
  recipient: string;
  status: "success" | "failed" | "skipped";
  timestamp: string;
  error?: A2AError;
}

/** Options for creating an A2A adapter */
export interface A2AAdapterConfig {
  /** This agent's unique ID */
  agentId: string;
  /** This agent's human-readable name */
  agentName: string;
  /** Agent version */
  version?: string;
  /** Agent capabilities */
  capabilities?: A2ACapability[];
  /** Agent metadata */
  metadata?: Record<string, unknown>;
  /** Communication endpoint URL */
  endpoint?: string;
  /** Agent role (passed to mailbox agent registry) */
  role?: string;
}

/** Options for sending A2A messages */
export interface A2ASendOptions {
  /** Message type */
  type: A2AMessageType;
  /** Recipient agent IDs */
  to: string[];
  /** Message topic */
  topic?: string;
  /** Message payload */
  payload: unknown;
  /** Message headers */
  headers?: Record<string, unknown>;
  /** Session ID */
  session_id?: string;
  /** Trace ID */
  trace_id?: string;
  /** Reply to specific message */
  reply_to?: string;
  /** Priority */
  priority?: "high" | "normal" | "low";
  /** TTL in seconds */
  ttl?: number;
}

/** Handler for incoming A2A messages */
export type A2AMessageHandler = (message: A2AMessage) => void | Promise<void>;

// ─── ID Generation ──────────────────────────────────────────────────

function generateA2AMessageId(): string {
  return `a2a_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── A2A Adapter ────────────────────────────────────────────────────

export class A2AAdapter {
  private mailbox: Mailbox;
  private config: Required<Pick<A2AAdapterConfig, "agentId" | "agentName" | "version" | "capabilities" | "metadata" | "endpoint">> & { role?: string };
  private handlers: A2AMessageHandler[] = [];
  private sessionMap: Map<string, A2ASession> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(mailbox: Mailbox, config: A2AAdapterConfig) {
    this.mailbox = mailbox;
    this.config = {
      agentId: config.agentId,
      agentName: config.agentName,
      version: config.version ?? "1.0.0",
      capabilities: config.capabilities ?? [],
      metadata: config.metadata ?? {},
      endpoint: config.endpoint ?? "",
      role: config.role,
    };
  }

  // ─── Agent Registration ───────────────────────────────────────────

  /** Register this agent in the mailbox agent registry */
  register(): void {
    this.mailbox.registerAgent(this.config.agentId, this.config.role ?? this.config.agentName);
  }

  /** Get this agent's A2A representation */
  getAgentInfo(): A2AAgent {
    return {
      id: this.config.agentId,
      name: this.config.agentName,
      version: this.config.version,
      capabilities: this.config.capabilities,
      metadata: this.config.metadata,
      endpoint: this.config.endpoint || undefined,
      status: "active",
      last_seen: new Date().toISOString(),
    };
  }

  // ─── Message Translation ──────────────────────────────────────────

  /** Convert an A2A message to mailbox SendOptions */
  private toMailboxOptions(a2aMsg: A2AMessage): SendOptions {
    const subject = a2aMsg.topic
      ? `[A2A:${a2aMsg.type}] ${a2aMsg.topic}`
      : `[A2A:${a2aMsg.type}] Message from ${a2aMsg.from}`;

    const body = JSON.stringify({
      id: a2aMsg.id,
      type: a2aMsg.type,
      payload: a2aMsg.payload,
      error: a2aMsg.error,
      headers: a2aMsg.headers,
      reply_to: a2aMsg.reply_to,
      sequence: a2aMsg.sequence,
    });

    const priority = a2aMsg.type === "request" ? "high" : "normal";

    return {
      from: a2aMsg.from,
      to: a2aMsg.to.length === 1 ? a2aMsg.to[0] : a2aMsg.to.join(","),
      subject,
      body,
      threadId: a2aMsg.session_id,
      priority,
      ttlSeconds: a2aMsg.headers?.["ttl"] as number | undefined,
      traceId: a2aMsg.trace_id,
      sessionId: a2aMsg.session_id,
      idempotencyKey: a2aMsg.id,
    };
  }

  /** Convert a mailbox Message to A2A message */
  private fromMailboxMessage(msg: Message): A2AMessage | null {
    try {
      const parsed = JSON.parse(msg.body) as {
        id?: string;
        type?: A2AMessageType;
        payload?: unknown;
        error?: A2AError;
        headers?: Record<string, unknown>;
        reply_to?: string;
        sequence?: number;
      };

      return {
        id: parsed.id ?? `mailbox-${msg.id}`,
        type: parsed.type ?? "notify",
        from: msg.from_agent,
        to: [msg.to_agent],
        topic: msg.subject.replace(/^\[A2A:\w+\]\s*/, ""),
        headers: parsed.headers,
        timestamp: msg.created_at,
        payload: parsed.payload ?? msg.body,
        error: parsed.error,
        session_id: msg.session_id || undefined,
        trace_id: msg.trace_id || undefined,
        reply_to: parsed.reply_to,
        sequence: parsed.sequence,
      };
    } catch {
      // Fallback: wrap the raw message as an A2A message
      return {
        id: `mailbox-${msg.id}`,
        type: "notify",
        from: msg.from_agent,
        to: [msg.to_agent],
        topic: msg.subject,
        timestamp: msg.created_at,
        payload: msg.body,
      };
    }
  }

  // ─── Sending Messages ─────────────────────────────────────────────

  /** Send an A2A message */
  send(opts: A2ASendOptions): { messageId: number; a2aId: string; threadId: string } {
    const a2aId = generateA2AMessageId();
    const session_id = opts.session_id ?? generateSessionId();

    const a2aMessage: A2AMessage = {
      id: a2aId,
      type: opts.type,
      from: this.config.agentId,
      to: opts.to,
      topic: opts.topic,
      headers: opts.headers,
      timestamp: new Date().toISOString(),
      payload: opts.payload,
      session_id,
      trace_id: opts.trace_id,
      reply_to: opts.reply_to,
    };

    const mailboxOpts = this.toMailboxOptions(a2aMessage);
    if (opts.priority) mailboxOpts.priority = opts.priority;
    if (opts.ttl) mailboxOpts.ttlSeconds = opts.ttl;

    const result = this.mailbox.send(mailboxOpts);

    return {
      messageId: result.messageId,
      a2aId,
      threadId: result.threadId,
    };
  }

  /** Broadcast an A2A message to all agents */
  broadcast(opts: Omit<A2ASendOptions, "to">): { messageId: number; a2aId: string; threadId: string } {
    return this.send({ ...opts, to: ["broadcast"] });
  }

  /** Send a request and wait for a reply (sync pattern) */
  async request(
    opts: Omit<A2ASendOptions, "type"> & { timeoutMs?: number }
  ): Promise<{ reply: A2AMessage } | { timeout: true; a2aId: string; threadId: string }> {
    const { messageId, a2aId, threadId } = this.send({ ...opts, type: "request" });

    const result = await this.mailbox.request({
      from: this.config.agentId,
      to: opts.to[0],
      subject: `[A2A:request] ${opts.topic ?? "sync-request"}`,
      body: JSON.stringify({ payload: opts.payload }),
      threadId,
      priority: "high",
      timeoutMs: opts.timeoutMs,
    });

    if ("reply" in result) {
      const a2aReply = this.fromMailboxMessage(result.reply);
      return a2aReply ? { reply: a2aReply } : { timeout: true, a2aId, threadId };
    }

    return { timeout: true, a2aId, threadId };
  }

  /** Send an error response */
  sendError(originalMessage: A2AMessage, code: string, message: string, details?: unknown): { messageId: number; a2aId: string; threadId: string } {
    return this.send({
      type: "response",
      to: [originalMessage.from],
      topic: originalMessage.topic,
      payload: null,
      reply_to: originalMessage.id,
      session_id: originalMessage.session_id,
      trace_id: originalMessage.trace_id,
    });
  }

  // ─── Receiving Messages ───────────────────────────────────────────

  /** Register a message handler */
  onMessage(handler: A2AMessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Read inbox and deliver to handlers */
  receive(limit = 20): A2AMessage[] {
    const messages = this.mailbox.readInbox({
      agent: this.config.agentId,
      limit,
    });

    const a2aMessages: A2AMessage[] = [];

    for (const msg of messages) {
      const a2aMsg = this.fromMailboxMessage(msg);
      if (a2aMsg) {
        a2aMessages.push(a2aMsg);
        this.mailbox.markRead(msg.id);

        // Deliver to handlers
        for (const handler of this.handlers) {
          try {
            void handler(a2aMsg);
          } catch {
            // Handler errors are isolated
          }
        }
      }
    }

    return a2aMessages;
  }

  /** Start polling for messages at a given interval */
  startPolling(intervalMs = 5000, limit = 20): void {
    if (this.pollInterval) {
      this.stopPolling();
    }

    this.pollInterval = setInterval(() => {
      this.receive(limit);
    }, intervalMs);
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Acknowledge a message */
  acknowledge(messageId: number): void {
    this.mailbox.acknowledge(messageId);
  }

  // ─── Sessions ─────────────────────────────────────────────────────

  /** Create an A2A session */
  createSession(participants: string[], metadata?: Record<string, unknown>): A2ASession {
    const session: A2ASession = {
      id: generateSessionId(),
      initiator: this.config.agentId,
      participants: [this.config.agentId, ...participants],
      started_at: new Date().toISOString(),
      metadata,
    };

    this.sessionMap.set(session.id, session);
    return session;
  }

  /** Get a session by ID */
  getSession(sessionId: string): A2ASession | undefined {
    return this.sessionMap.get(sessionId);
  }

  /** List active sessions */
  listSessions(): A2ASession[] {
    return Array.from(this.sessionMap.values()).filter((s) => !s.ended_at);
  }

  /** End a session */
  endSession(sessionId: string): void {
    const session = this.sessionMap.get(sessionId);
    if (session) {
      session.ended_at = new Date().toISOString();
    }
  }

  // ─── Discovery ────────────────────────────────────────────────────

  /** List all agents from the mailbox registry */
  listAgents(): A2AAgent[] {
    const agents = this.mailbox.listAgents();
    return agents.map((agent) => ({
      id: agent.name,
      name: agent.name,
      role: agent.role ?? undefined,
      status: agent.lastActive ? "active" as const : "inactive" as const,
      last_seen: agent.lastActive ?? new Date().toISOString(),
    }));
  }

  /** Find agents by name pattern */
  findAgents(pattern: string): A2AAgent[] {
    return this.listAgents().filter((agent) =>
      agent.id.includes(pattern) || agent.name.includes(pattern)
    );
  }

  // ─── Utilities ────────────────────────────────────────────────────

  /** Get mailbox metrics */
  getMetrics() {
    return this.mailbox.metrics();
  }

  /** Cleanup */
  close(): void {
    this.stopPolling();
    this.sessionMap.clear();
    this.handlers.length = 0;
  }
}

// ─── Standalone Functions ───────────────────────────────────────────

/** Convert a mailbox Message to an A2A message (standalone) */
export function mailboxMessageToA2A(msg: Message): A2AMessage | null {
  try {
    const parsed = JSON.parse(msg.body) as {
      id?: string;
      type?: A2AMessageType;
      payload?: unknown;
      error?: A2AError;
      headers?: Record<string, unknown>;
      reply_to?: string;
      sequence?: number;
    };

    return {
      id: parsed.id ?? `mailbox-${msg.id}`,
      type: parsed.type ?? "notify",
      from: msg.from_agent,
      to: [msg.to_agent],
      topic: msg.subject.replace(/^\[A2A:\w+\]\s*/, ""),
      headers: parsed.headers,
      timestamp: msg.created_at,
      payload: parsed.payload ?? msg.body,
      error: parsed.error,
      session_id: msg.session_id || undefined,
      trace_id: msg.trace_id || undefined,
      reply_to: parsed.reply_to,
      sequence: parsed.sequence,
    };
  } catch {
    return {
      id: `mailbox-${msg.id}`,
      type: "notify",
      from: msg.from_agent,
      to: [msg.to_agent],
      topic: msg.subject,
      timestamp: msg.created_at,
      payload: msg.body,
    };
  }
}

/** Convert an A2A message to mailbox SendOptions (standalone) */
export function a2aToMailboxOptions(a2aMsg: A2AMessage): SendOptions {
  const subject = a2aMsg.topic
    ? `[A2A:${a2aMsg.type}] ${a2aMsg.topic}`
    : `[A2A:${a2aMsg.type}] Message from ${a2aMsg.from}`;

  return {
    from: a2aMsg.from,
    to: a2aMsg.to.length === 1 ? a2aMsg.to[0] : a2aMsg.to.join(","),
    subject,
    body: JSON.stringify({
      id: a2aMsg.id,
      type: a2aMsg.type,
      payload: a2aMsg.payload,
      error: a2aMsg.error,
      headers: a2aMsg.headers,
      reply_to: a2aMsg.reply_to,
      sequence: a2aMsg.sequence,
    }),
    threadId: a2aMsg.session_id,
    priority: a2aMsg.type === "request" ? "high" : "normal",
    ttlSeconds: a2aMsg.headers?.["ttl"] as number | undefined,
    traceId: a2aMsg.trace_id,
    sessionId: a2aMsg.session_id,
    idempotencyKey: a2aMsg.id,
  };
}

/** Create an A2A error response */
export function createA2AError(
  originalMessage: A2AMessage,
  code: string,
  message: string,
  details?: unknown
): A2AMessage {
  return {
    id: generateA2AMessageId(),
    type: "response",
    from: originalMessage.to[0] ?? "",
    to: [originalMessage.from],
    topic: originalMessage.topic,
    headers: {},
    timestamp: new Date().toISOString(),
    payload: null,
    error: { code, message, details },
    reply_to: originalMessage.id,
    session_id: originalMessage.session_id,
    trace_id: originalMessage.trace_id,
  };
}

/** Validate an A2A message structure */
export function validateA2AMessage(msg: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!msg || typeof msg !== "object") {
    return { valid: false, errors: ["Message must be an object"] };
  }

  const m = msg as Record<string, unknown>;

  if (typeof m.id !== "string" || !m.id) errors.push("id must be a non-empty string");
  if (typeof m.type !== "string") errors.push("type must be a string");
  else if (!["request", "response", "notify", "event", "stream"].includes(m.type))
    errors.push(`type must be one of: request, response, notify, event, stream (got: ${m.type})`);
  if (typeof m.from !== "string" || !m.from) errors.push("from must be a non-empty string");
  if (!Array.isArray(m.to)) errors.push("to must be an array");
  if (m.timestamp && typeof m.timestamp !== "string") errors.push("timestamp must be a string");

  return { valid: errors.length === 0, errors };
}
