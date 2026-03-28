/**
 * OpenCode Plugin wrapper for agent-mailbox
 *
 * Usage in opencode.json:
 *   "plugin": ["agent-mailbox/plugin"]
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Mailbox } from "./mailbox.js";
import { formatMessages, formatThreads, formatAgents, formatDeadLetters, formatMetrics } from "./format.js";
import type { Message } from "./types.js";

const MESSAGING_INSTRUCTIONS = `## Agent Mailbox (Peer-to-Peer Enabled)
Tools: \`msg_send\`, \`msg_request\`, \`msg_read_inbox\`, \`msg_broadcast\`, \`msg_acknowledge\`, \`msg_search\`, \`msg_list_threads\`, \`msg_list_agents\`, \`msg_activity_feed\`, \`msg_metrics\`, \`msg_dead_letters\`.
Protocol:
1) \`msg_read_inbox\` at task start — check for pending messages.
2) \`msg_send\` discoveries to affected agents.
3) \`msg_request\` for questions needing answers (uses exponential backoff).
4) Use same thread_id for replies.
5) \`msg_acknowledge\` messages you've processed to prevent re-delivery.
6) Priority: high=blockers, normal=info, low=FYI.
P2P: Message ANY agent directly. Use \`msg_list_agents\` to discover available agents.
`;

export default (async (ctx) => {
  const dbPath = process.env.AGENT_MAILBOX_DB ?? `${process.env.HOME ?? process.env.USERPROFILE}/.agent-mailbox/mailbox.db`;

  const mailbox = new Mailbox({
    dbPath,
    defaultTTL: Number(process.env.AGENT_MAILBOX_TTL) || 86400,
    visibilityTimeout: Number(process.env.AGENT_MAILBOX_VIS_TIMEOUT) || 300,
    maxRetries: Number(process.env.AGENT_MAILBOX_MAX_RETRIES) || 3,
    maxBodySize: Number(process.env.AGENT_MAILBOX_MAX_BODY) || 65536,
    rateLimitPerMinute: Number(process.env.AGENT_MAILBOX_RATE_LIMIT) || 60,
  });

  return {
    tool: {
      msg_send: tool({
        description:
          "Send a direct message to a specific agent. Supports priority, threading, TTL, and idempotency.",
        args: {
          to_agent: tool.schema.string().describe("Target agent name"),
          subject: tool.schema.string().describe("Brief subject line"),
          body: tool.schema.string().describe("Message content — be specific and actionable"),
          thread_id: tool.schema.string().optional().describe("Thread ID to continue an existing conversation"),
          priority: tool.schema.enum(["high", "normal", "low"]).optional().describe("Defaults to 'normal'"),
          ttl_seconds: tool.schema.number().optional().describe("Message TTL in seconds. Defaults to 24h."),
          idempotency_key: tool.schema.string().optional().describe("Unique key to prevent duplicate sends"),
          trace_id: tool.schema.string().optional().describe("Trace ID for cross-workflow observability"),
        },
        async execute(args, context) {
          const from = context.agent ?? "unknown";
          const { messageId, threadId } = mailbox.send({
            from,
            to: args.to_agent,
            subject: args.subject,
            body: args.body,
            threadId: args.thread_id,
            priority: args.priority,
            ttlSeconds: args.ttl_seconds,
            idempotencyKey: args.idempotency_key,
            traceId: args.trace_id,
            sessionId: context.sessionID,
          });
          return `Message #${messageId} sent to @${args.to_agent} in thread ${threadId}.`;
        },
      }),

      msg_read_inbox: tool({
        description:
          "Read unread messages. Messages get a visibility timeout — acknowledge them to prevent re-delivery.",
        args: {
          limit: tool.schema.number().optional().describe("Max messages. Defaults to 20."),
          include_read: tool.schema.boolean().optional().describe("Include already-read messages. Defaults to false."),
        },
        async execute(args, context) {
          const agent = context.agent ?? "unknown";
          const messages = mailbox.readInbox({
            agent,
            limit: args.limit,
            includeRead: args.include_read,
          });
          return `Inbox for @${agent} (${messages.length} messages):\n\n${formatMessages(messages)}`;
        },
      }),

      msg_acknowledge: tool({
        description:
          "Acknowledge a message — confirms processing complete and prevents re-delivery. Optionally send a reply.",
        args: {
          message_id: tool.schema.number().describe("Message ID to acknowledge"),
          response: tool.schema.string().optional().describe("Optional reply to the sender"),
        },
        async execute(args, context) {
          const agent = context.agent ?? "unknown";
          const reply = args.response
            ? mailbox.acknowledge(args.message_id, { from: agent, body: args.response, sessionId: context.sessionID })
            : (mailbox.acknowledge(args.message_id), null);

          if (reply) {
            return `Message #${args.message_id} acknowledged. Reply #${reply.messageId} sent in thread ${reply.threadId}.`;
          }
          return `Message #${args.message_id} acknowledged.`;
        },
      }),

      msg_search: tool({
        description: "Search messages by content. Supports FTS5 syntax (AND, OR, NOT, quotes).",
        args: {
          query: tool.schema.string().describe("Search query"),
          limit: tool.schema.number().optional().describe("Max results. Defaults to 10."),
        },
        async execute(args) {
          const { messages, usedFallback } = mailbox.search({ query: args.query, limit: args.limit });
          const prefix = usedFallback ? "Warning: FTS5 failed, using simple search.\n\n" : "";
          return `${prefix}Search results for "${args.query}" (${messages.length} found):\n\n${formatMessages(messages)}`;
        },
      }),

      msg_broadcast: tool({
        description: "Broadcast to ALL agents. Use sparingly — only for critical discoveries.",
        args: {
          subject: tool.schema.string().describe("Broadcast subject"),
          body: tool.schema.string().describe("Important discovery or decision"),
          priority: tool.schema.enum(["high", "normal", "low"]).optional().describe("Defaults to 'normal'"),
        },
        async execute(args, context) {
          const from = context.agent ?? "unknown";
          const { messageId, threadId } = mailbox.broadcast({
            from,
            subject: args.subject,
            body: args.body,
            priority: args.priority,
            sessionId: context.sessionID,
          });
          return `Broadcast #${messageId} sent from @${from}. Thread: ${threadId}.`;
        },
      }),

      msg_list_threads: tool({
        description: "List active conversation threads with message/unread counts.",
        args: {
          limit: tool.schema.number().optional().describe("Max threads. Defaults to 10."),
        },
        async execute(args, context) {
          const agent = context.agent ?? "unknown";
          const threads = mailbox.listThreads(agent, args.limit);
          return formatThreads(threads);
        },
      }),

      msg_request: tool({
        description:
          "Send a message and wait for a reply (exponential backoff). Use for questions that need an answer before proceeding.",
        args: {
          to_agent: tool.schema.string().describe("Target agent"),
          subject: tool.schema.string().describe("Question subject"),
          body: tool.schema.string().describe("Your question — be specific"),
          timeout_seconds: tool.schema.number().optional().describe("Max seconds to wait. Defaults to 120."),
        },
        async execute(args, context) {
          const from = context.agent ?? "unknown";
          const result = await mailbox.request({
            from,
            to: args.to_agent,
            subject: args.subject,
            body: args.body,
            timeoutMs: (args.timeout_seconds ?? 120) * 1000,
            sessionId: context.sessionID,
          });

          if ("reply" in result) {
            return `Reply from @${args.to_agent}:\n\nSubject: ${result.reply.subject}\n---\n${result.reply.body}`;
          }
          return `TIMEOUT: No reply from @${args.to_agent} after ${args.timeout_seconds ?? 120}s. Message #${result.messageId} in thread ${result.threadId}.`;
        },
      }),

      msg_list_agents: tool({
        description: "List registered agents with activity status. Agents are auto-registered on first message.",
        args: {},
        async execute() {
          const agents = mailbox.listAgents();
          return formatAgents(agents);
        },
      }),

      msg_activity_feed: tool({
        description: "Recent message activity timeline for monitoring.",
        args: {
          limit: tool.schema.number().optional().describe("Max messages. Defaults to 20."),
          minutes: tool.schema.number().optional().describe("Time window in minutes. Defaults to 30."),
        },
        async execute(args) {
          const limit = args.limit ?? 20;
          const minutes = args.minutes ?? 30;
          const rows = mailbox.db.prepare(`
            SELECT id, from_agent, to_agent, subject, priority, thread_id, status, created_at
            FROM messages
            WHERE created_at > datetime('now', '-' || $minutes || ' minutes')
            ORDER BY created_at DESC
            LIMIT $limit
          `).all({ $minutes: minutes, $limit: limit }) as any[];

          if (!rows || rows.length === 0) return `No activity in the last ${minutes} minutes.`;

          const header = `Activity Feed (last ${minutes}min, ${rows.length} messages):\n${"=".repeat(50)}\n`;
          const feed = rows.map((m: any) =>
            `${m.created_at} | @${m.from_agent} -> @${m.to_agent} | ${m.priority === "high" ? "!! " : ""}${m.subject} [${m.status}]`
          ).join("\n");
          return header + feed;
        },
      }),

      msg_metrics: tool({
        description: "Get mailbox metrics: message counts, queue depths, delivery times.",
        args: {},
        async execute() {
          return formatMetrics(mailbox.metrics());
        },
      }),

      msg_dead_letters: tool({
        description: "View or replay messages in the dead letter queue (failed after max retries).",
        args: {
          action: tool.schema.enum(["list", "replay"]).optional().describe("Action: 'list' (default) or 'replay'"),
          id: tool.schema.number().optional().describe("Dead letter ID to replay (required for 'replay' action)"),
        },
        async execute(args) {
          if (args.action === "replay" && args.id) {
            const result = mailbox.replayDeadLetter(args.id);
            if (result) return `Dead letter #${args.id} replayed as message #${result.messageId} in thread ${result.threadId}.`;
            return `Dead letter #${args.id} not found.`;
          }
          return formatDeadLetters(mailbox.getDeadLetters());
        },
      }),
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      output.system.push(MESSAGING_INSTRUCTIONS);
    },
  };
}) satisfies Plugin;
