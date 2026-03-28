/**
 * Core types for Agent Mailbox
 */

/** Message priority levels */
export type Priority = "high" | "normal" | "low";

/** Message delivery status */
export type DeliveryStatus =
  | "pending"    // In queue, not yet delivered
  | "delivered"  // Fetched by recipient (visibility timeout started)
  | "read"       // Marked as read by recipient
  | "acked"      // Acknowledged/processed
  | "expired"    // TTL exceeded
  | "dead";      // Failed N times, moved to DLQ

/** Configuration options for the mailbox */
export interface MailboxConfig {
  /** Path to SQLite database file. Defaults to ':memory:' */
  dbPath?: string;
  /** Default message TTL in seconds. Defaults to 86400 (24h) */
  defaultTTL?: number;
  /** Visibility timeout in seconds after message is fetched. Defaults to 300 (5min) */
  visibilityTimeout?: number;
  /** Max retry attempts before moving to DLQ. Defaults to 3 */
  maxRetries?: number;
  /** Max message body size in bytes. Defaults to 65536 (64KB) */
  maxBodySize?: number;
  /** Rate limit: max messages per agent per minute. Defaults to 60 */
  rateLimitPerMinute?: number;
  /** Enable WAL mode for better concurrency. Defaults to true */
  walMode?: boolean;
  /** Cleanup interval in seconds. 0 disables auto-cleanup. Defaults to 300 (5min) */
  cleanupInterval?: number;
}

/** Resolved config with all defaults applied */
export interface ResolvedConfig {
  dbPath: string;
  defaultTTL: number;
  visibilityTimeout: number;
  maxRetries: number;
  maxBodySize: number;
  rateLimitPerMinute: number;
  walMode: boolean;
  cleanupInterval: number;
}

/** A message in the mailbox */
export interface Message {
  id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  thread_id: string;
  priority: Priority;
  status: DeliveryStatus;
  ttl_seconds: number;
  idempotency_key: string | null;
  trace_id: string | null;
  receive_count: number;
  visible_after: string | null;
  session_id: string;
  created_at: string;
  read_at: string | null;
  ack_at: string | null;
  expires_at: string;
}

/** Options for sending a message */
export interface SendOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  priority?: Priority;
  ttlSeconds?: number;
  idempotencyKey?: string;
  traceId?: string;
  sessionId?: string;
}

/** Options for reading inbox */
export interface InboxOptions {
  agent: string;
  limit?: number;
  includeRead?: boolean;
}

/** Options for searching messages */
export interface SearchOptions {
  query: string;
  limit?: number;
  agent?: string;
}

/** A conversation thread */
export interface Thread {
  id: string;
  subject: string;
  participants: string;
  message_count: number;
  unread_count: number;
  last_message_at: string;
}

/** Result of sending a message */
export interface SendResult {
  messageId: number;
  threadId: string;
  idempotencyKey: string | null;
}

/** Dead letter entry */
export interface DeadLetter {
  id: number;
  original_message_id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  thread_id: string;
  reason: string;
  moved_at: string;
}

/** Metrics snapshot */
export interface MailboxMetrics {
  totalMessages: number;
  pendingMessages: number;
  deliveredMessages: number;
  deadLetters: number;
  activeThreads: number;
  messagesPerAgent: Record<string, number>;
  avgDeliveryTimeMs: number | null;
}

/** Agent info for registry */
export interface AgentInfo {
  name: string;
  role?: string;
  lastActive: string | null;
  messageCount: number;
}
