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
