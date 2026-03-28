/**
 * Message formatting utilities
 */

import type { Message, Thread, AgentInfo, DeadLetter, MailboxMetrics } from "./types.js";

export function formatMessages(rows: Message[]): string {
  if (!rows || rows.length === 0) return "No messages found.";
  return rows
    .map(
      (m) =>
        `[#${m.id}] ${m.priority === "high" ? "!! " : m.priority === "low" ? "-- " : ""}` +
        `From: @${m.from_agent} -> To: @${m.to_agent}\n` +
        `Subject: ${m.subject}\n` +
        `Thread: ${m.thread_id} | Status: ${m.status} | Receives: ${m.receive_count}\n` +
        `Time: ${m.created_at} | Expires: ${m.expires_at}` +
        `${m.read_at ? ` | Read: ${m.read_at}` : ""}` +
        `${m.ack_at ? ` | Acked: ${m.ack_at}` : ""}\n` +
        `${m.trace_id ? `Trace: ${m.trace_id}\n` : ""}` +
        `---\n${m.body}\n`
    )
    .join("\n" + "=".repeat(50) + "\n\n");
}

export function formatThreads(threads: Thread[]): string {
  if (!threads || threads.length === 0) return "No active threads.";
  return threads
    .map(
      (t) =>
        `[${t.id}] ${t.subject}\n` +
        `  Messages: ${t.message_count} | Unread: ${t.unread_count}\n` +
        `  Last activity: ${t.last_message_at}`
    )
    .join("\n\n");
}

export function formatAgents(agents: AgentInfo[]): string {
  if (!agents || agents.length === 0) return "No registered agents.";
  return agents
    .map(
      (a) =>
        `@${a.name} [${a.messageCount} msgs]` +
        `${a.lastActive ? ` last active: ${a.lastActive}` : " (never active)"}\n` +
        `  ${a.role ?? "No role defined"}`
    )
    .join("\n\n");
}

export function formatDeadLetters(dls: DeadLetter[]): string {
  if (!dls || dls.length === 0) return "Dead letter queue is empty.";
  return dls
    .map(
      (d) =>
        `[DLQ #${d.id}] Original: #${d.original_message_id}\n` +
        `From: @${d.from_agent} -> To: @${d.to_agent}\n` +
        `Subject: ${d.subject}\n` +
        `Reason: ${d.reason}\n` +
        `Moved: ${d.moved_at}\n` +
        `---\n${d.body}\n`
    )
    .join("\n" + "=".repeat(50) + "\n\n");
}

export function formatMetrics(m: MailboxMetrics): string {
  const lines = [
    `Mailbox Metrics`,
    `${"=".repeat(40)}`,
    `Total messages: ${m.totalMessages}`,
    `Pending: ${m.pendingMessages}`,
    `Delivered (in-flight): ${m.deliveredMessages}`,
    `Dead letters: ${m.deadLetters}`,
    `Active threads (last 1h): ${m.activeThreads}`,
    `Avg delivery time: ${m.avgDeliveryTimeMs ? `${Math.round(m.avgDeliveryTimeMs)}ms` : "N/A"}`,
    ``,
    `Messages per agent:`,
    ...Object.entries(m.messagesPerAgent).map(([a, c]) => `  @${a}: ${c}`),
  ];
  return lines.join("\n");
}
