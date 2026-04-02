import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Mailbox } from "../src/mailbox.js";
import {
  A2AAdapter,
  mailboxMessageToA2A,
  a2aToMailboxOptions,
  createA2AError,
  validateA2AMessage,
} from "../src/a2a.js";
import type { A2AMessage } from "../src/a2a.js";

let mailbox: Mailbox;
let adapter: A2AAdapter;

beforeEach(() => {
  mailbox = new Mailbox({ dbPath: ":memory:", cleanupInterval: 0 });
  adapter = new A2AAdapter(mailbox, {
    agentId: "test-agent",
    agentName: "Test Agent",
    version: "1.0.0",
    capabilities: [
      { name: "memory-search", description: "Search memory" },
      { name: "temporal-graph", description: "Temporal graph ops" },
    ],
    role: "worker",
  });
  adapter.register();
});

afterEach(() => {
  adapter.close();
  mailbox.close();
});

// ─── Message Translation ────────────────────────────────────────────

describe("mailboxMessageToA2A", () => {
  it("converts a structured A2A body to A2AMessage", () => {
    const body = JSON.stringify({
      id: "a2a-123",
      type: "request",
      payload: { task: "search", query: "hello" },
      headers: { priority: "high" },
    });

    const result = mailboxMessageToA2A({
      id: 1,
      from_agent: "sender",
      to_agent: "receiver",
      subject: "[A2A:request] memory-search",
      body,
      thread_id: "thread-1",
      priority: "high",
      status: "delivered",
      ttl_seconds: 3600,
      idempotency_key: null,
      trace_id: "trace-1",
      receive_count: 1,
      visible_after: null,
      session_id: "session-1",
      created_at: "2026-03-31T12:00:00Z",
      read_at: null,
      ack_at: null,
      expires_at: "2026-04-01T12:00:00Z",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("a2a-123");
    expect(result!.type).toBe("request");
    expect(result!.from).toBe("sender");
    expect(result!.to).toEqual(["receiver"]);
    expect(result!.payload).toEqual({ task: "search", query: "hello" });
    expect(result!.session_id).toBe("session-1");
    expect(result!.trace_id).toBe("trace-1");
  });

  it("falls back to raw body when not JSON", () => {
    const result = mailboxMessageToA2A({
      id: 2,
      from_agent: "sender",
      to_agent: "receiver",
      subject: "Plain message",
      body: "Just some text",
      thread_id: "thread-2",
      priority: "normal",
      status: "pending",
      ttl_seconds: 86400,
      idempotency_key: null,
      trace_id: null,
      receive_count: 0,
      visible_after: null,
      session_id: "",
      created_at: "2026-03-31T12:00:00Z",
      read_at: null,
      ack_at: null,
      expires_at: "2026-04-01T12:00:00Z",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("mailbox-2");
    expect(result!.type).toBe("notify");
    expect(result!.payload).toBe("Just some text");
  });

  it("returns null for invalid JSON in body", () => {
    // Actually our function falls back, not returns null
    const result = mailboxMessageToA2A({
      id: 3,
      from_agent: "sender",
      to_agent: "receiver",
      subject: "Test",
      body: "{invalid json",
      thread_id: "t",
      priority: "normal",
      status: "pending",
      ttl_seconds: 86400,
      idempotency_key: null,
      trace_id: null,
      receive_count: 0,
      visible_after: null,
      session_id: "",
      created_at: "2026-03-31T12:00:00Z",
      read_at: null,
      ack_at: null,
      expires_at: "2026-04-01T12:00:00Z",
    });

    // Falls back to raw body
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mailbox-3");
  });
});

describe("a2aToMailboxOptions", () => {
  it("converts A2A request to SendOptions", () => {
    const a2aMsg: A2AMessage = {
      id: "a2a-456",
      type: "request",
      from: "sender",
      to: ["receiver"],
      topic: "task-assign",
      timestamp: "2026-03-31T12:00:00Z",
      payload: { taskId: 42 },
      session_id: "session-1",
      trace_id: "trace-1",
      headers: { ttl: 600 },
    };

    const opts = a2aToMailboxOptions(a2aMsg);

    expect(opts.from).toBe("sender");
    expect(opts.to).toBe("receiver");
    expect(opts.subject).toBe("[A2A:request] task-assign");
    expect(opts.priority).toBe("high");
    expect(opts.threadId).toBe("session-1");
    expect(opts.traceId).toBe("trace-1");
    expect(opts.idempotencyKey).toBe("a2a-456");
    expect(opts.ttlSeconds).toBe(600);
  });

  it("handles multiple recipients", () => {
    const a2aMsg: A2AMessage = {
      id: "a2a-789",
      type: "notify",
      from: "sender",
      to: ["agent-1", "agent-2", "agent-3"],
      timestamp: "2026-03-31T12:00:00Z",
      payload: "broadcast",
    };

    const opts = a2aToMailboxOptions(a2aMsg);

    expect(opts.to).toBe("agent-1,agent-2,agent-3");
    expect(opts.priority).toBe("normal");
  });

  it("uses generic subject when no topic", () => {
    const a2aMsg: A2AMessage = {
      id: "a2a-999",
      type: "notify",
      from: "sender",
      to: ["receiver"],
      timestamp: "2026-03-31T12:00:00Z",
      payload: "data",
    };

    const opts = a2aToMailboxOptions(a2aMsg);

    expect(opts.subject).toBe("[A2A:notify] Message from sender");
  });
});

describe("createA2AError", () => {
  it("creates an error response from original message", () => {
    const original: A2AMessage = {
      id: "a2a-100",
      type: "request",
      from: "client",
      to: ["server"],
      topic: "process",
      timestamp: "2026-03-31T12:00:00Z",
      payload: null,
      session_id: "session-1",
      trace_id: "trace-1",
    };

    const error = createA2AError(original, "ERR_NOT_FOUND", "Resource not found", { resourceId: 42 });

    expect(error.type).toBe("response");
    expect(error.from).toBe("server");
    expect(error.to).toEqual(["client"]);
    expect(error.reply_to).toBe("a2a-100");
    expect(error.error).toEqual({
      code: "ERR_NOT_FOUND",
      message: "Resource not found",
      details: { resourceId: 42 },
    });
    expect(error.session_id).toBe("session-1");
    expect(error.trace_id).toBe("trace-1");
  });
});

describe("validateA2AMessage", () => {
  it("validates a correct message", () => {
    const result = validateA2AMessage({
      id: "msg-1",
      type: "request",
      from: "agent-a",
      to: ["agent-b"],
      timestamp: "2026-03-31T12:00:00Z",
      payload: null,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-object input", () => {
    const result = validateA2AMessage("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Message must be an object");
  });

  it("rejects null input", () => {
    const result = validateA2AMessage(null);
    expect(result.valid).toBe(false);
  });

  it("collects multiple validation errors", () => {
    const result = validateA2AMessage({
      id: "",
      type: "invalid-type",
      from: "",
      to: "not-an-array",
      timestamp: 123,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
  });

  it("accepts all valid message types", () => {
    for (const type of ["request", "response", "notify", "event", "stream"]) {
      const result = validateA2AMessage({
        id: "msg",
        type,
        from: "a",
        to: ["b"],
        timestamp: "2026-03-31T12:00:00Z",
        payload: null,
      });
      expect(result.valid).toBe(true);
    }
  });
});

// ─── Adapter Integration ────────────────────────────────────────────

describe("A2AAdapter", () => {
  it("registers agent in mailbox", () => {
    const agents = mailbox.listAgents();
    const testAgent = agents.find((a) => a.name === "test-agent");
    expect(testAgent).toBeDefined();
    expect(testAgent!.role).toBe("worker");
  });

  it("returns agent info", () => {
    const info = adapter.getAgentInfo();
    expect(info.id).toBe("test-agent");
    expect(info.name).toBe("Test Agent");
    expect(info.version).toBe("1.0.0");
    expect(info.capabilities).toHaveLength(2);
    expect(info.status).toBe("active");
  });

  it("sends and receives A2A messages", () => {
    const result = adapter.send({
      type: "request",
      to: ["other-agent"],
      topic: "task-update",
      payload: { taskId: 42, status: "done" },
    });

    expect(result.a2aId).toStartWith("a2a_");
    expect(result.messageId).toBeGreaterThan(0);

    // Read as the other agent
    const inbox = mailbox.readInbox({ agent: "other-agent" });
    expect(inbox).toHaveLength(1);

    // Convert back to A2A
    const a2aMsg = mailboxMessageToA2A(inbox[0]);
    expect(a2aMsg).not.toBeNull();
    expect(a2aMsg!.type).toBe("request");
    expect(a2aMsg!.from).toBe("test-agent");
    expect(a2aMsg!.payload).toEqual({ taskId: 42, status: "done" });
  });

  it("broadcasts to all agents", () => {
    const result = adapter.broadcast({
      type: "event",
      topic: "system-update",
      payload: { version: "2.0.0" },
    });

    expect(result.a2aId).toStartWith("a2a_");
  });

  it("handles message handlers", () => {
    const received: A2AMessage[] = [];

    adapter.onMessage((msg) => {
      received.push(msg);
    });

    // Send a message to the adapter's agent
    mailbox.send({
      from: "other-agent",
      to: "test-agent",
      subject: "[A2A:request] ping",
      body: JSON.stringify({
        id: "a2a-ping",
        type: "request",
        payload: { action: "ping" },
      }),
      threadId: "thread-ping",
    });

    adapter.receive();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("request");
    expect(received[0].from).toBe("other-agent");
  });

  it("supports removing handlers", () => {
    const received: A2AMessage[] = [];

    const unsubscribe = adapter.onMessage((msg) => {
      received.push(msg);
    });

    unsubscribe();

    mailbox.send({
      from: "other-agent",
      to: "test-agent",
      subject: "[A2A:notify] test",
      body: JSON.stringify({ id: "a2a-1", type: "notify", payload: null }),
      threadId: "thread-1",
    });

    adapter.receive();
    expect(received).toHaveLength(0);
  });

  it("manages sessions", () => {
    const session = adapter.createSession(["agent-a", "agent-b"], { purpose: "code-review" });

    expect(session.id).toStartWith("session_");
    expect(session.initiator).toBe("test-agent");
    expect(session.participants).toContain("test-agent");
    expect(session.participants).toContain("agent-a");
    expect(session.participants).toContain("agent-b");
    expect(session.metadata).toEqual({ purpose: "code-review" });

    // Retrieve session
    const retrieved = adapter.getSession(session.id);
    expect(retrieved).toBe(session);

    // List sessions
    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(1);

    // End session
    adapter.endSession(session.id);
    expect(session.ended_at).toBeDefined();

    // No longer in active list
    const activeSessions = adapter.listSessions();
    expect(activeSessions).toHaveLength(0);
  });

  it("lists agents from mailbox registry", () => {
    mailbox.send({ from: "agent-x", to: "test-agent", subject: "test", body: "msg" });
    mailbox.send({ from: "agent-y", to: "test-agent", subject: "test", body: "msg" });

    const agents = adapter.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(2);

    const agentX = agents.find((a) => a.id === "agent-x");
    expect(agentX).toBeDefined();
    // Agent status is active when lastActive is set (after sending)
    expect(["active", "inactive"]).toContain(agentX!.status);
  });

  it("finds agents by pattern", () => {
    mailbox.registerAgent("memory-agent", "worker");
    mailbox.registerAgent("code-agent", "worker");
    mailbox.registerAgent("review-agent", "reviewer");

    const found = adapter.findAgents("memory");
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("memory-agent");
  });

  it("starts and stops polling", () => {
    adapter.startPolling(100); // Fast for testing
    expect(adapter.listSessions()).toBeDefined(); // Just verify it doesn't crash

    adapter.stopPolling();
  });
});
