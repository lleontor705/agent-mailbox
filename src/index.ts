/**
 * agent-mailbox — Production-grade inter-agent messaging for multi-agent AI systems
 *
 * @example
 * ```ts
 * import { Mailbox } from "agent-mailbox";
 *
 * const mailbox = new Mailbox({ dbPath: "./mailbox.db" });
 *
 * // Send a message
 * const { messageId, threadId } = mailbox.send({
 *   from: "architect",
 *   to: "developer",
 *   subject: "API schema ready",
 *   body: "The OpenAPI spec is finalized. Proceed with implementation.",
 *   priority: "high",
 * });
 *
 * // Read inbox
 * const messages = mailbox.readInbox({ agent: "developer" });
 *
 * // Acknowledge
 * mailbox.acknowledge(messages[0].id);
 *
 * // Search
 * const { messages: results } = mailbox.search({ query: "API schema" });
 *
 * // Metrics
 * console.log(mailbox.metrics());
 *
 * mailbox.close();
 * ```
 */

export { Mailbox } from "./mailbox.js";
export { formatMessages, formatThreads, formatAgents, formatDeadLetters, formatMetrics } from "./format.js";
export type {
  Priority,
  DeliveryStatus,
  MailboxConfig,
  Message,
  SendOptions,
  SendResult,
  InboxOptions,
  SearchOptions,
  Thread,
  DeadLetter,
  MailboxMetrics,
  AgentInfo,
} from "./types.js";
