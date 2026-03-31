/**
 * Library exports for programmatic use
 *
 * @example
 * ```ts
 * import { Mailbox } from "agent-mailbox-core/lib";
 *
 * const mailbox = new Mailbox({ dbPath: "./mailbox.db" });
 * mailbox.send({ from: "a", to: "b", subject: "Hi", body: "Hello" });
 * mailbox.close();
 * ```
 */

export { Mailbox } from "./mailbox.js";
export {
  A2AAdapter,
  mailboxMessageToA2A,
  a2aToMailboxOptions,
  createA2AError,
  validateA2AMessage,
} from "./a2a.js";
export type {
  A2AMessage,
  A2AMessageType,
  A2AError,
  A2AAgent,
  A2ACapability,
  A2AAgentStatus,
  A2ASession,
  A2AAcknowledgment,
  A2AAdapterConfig,
  A2ASendOptions,
  A2AMessageHandler,
} from "./a2a.js";
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
