import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Mailbox } from "../src/mailbox.js";

let mailbox: Mailbox;

beforeEach(() => {
  mailbox = new Mailbox({ dbPath: ":memory:", cleanupInterval: 0 });
});

afterEach(() => {
  mailbox.close();
});

describe("send & receive", () => {
  it("sends a message and reads it in inbox", () => {
    const result = mailbox.send({
      from: "agent-a",
      to: "agent-b",
      subject: "Hello",
      body: "Test message",
    });

    expect(result.messageId).toBeGreaterThan(0);
    expect(result.threadId).toStartWith("thread-");

    const inbox = mailbox.readInbox({ agent: "agent-b" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].subject).toBe("Hello");
    expect(inbox[0].from_agent).toBe("agent-a");
    expect(inbox[0].status).toBe("pending"); // snapshot before claim update
  });

  it("does not show own messages in inbox", () => {
    mailbox.send({ from: "agent-a", to: "agent-a", subject: "Self", body: "Self-send" });
    const inbox = mailbox.readInbox({ agent: "agent-a" });
    expect(inbox).toHaveLength(0);
  });

  it("respects priority ordering", () => {
    mailbox.send({ from: "a", to: "b", subject: "Low", body: "low", priority: "low" });
    mailbox.send({ from: "a", to: "b", subject: "High", body: "high", priority: "high" });
    mailbox.send({ from: "a", to: "b", subject: "Normal", body: "normal" });

    const inbox = mailbox.readInbox({ agent: "b" });
    expect(inbox[0].subject).toBe("High");
    expect(inbox[1].subject).toBe("Normal");
    expect(inbox[2].subject).toBe("Low");
  });
});

describe("idempotency", () => {
  it("deduplicates messages with same idempotency key", () => {
    const r1 = mailbox.send({
      from: "a",
      to: "b",
      subject: "Test",
      body: "First",
      idempotencyKey: "key-123",
    });

    const r2 = mailbox.send({
      from: "a",
      to: "b",
      subject: "Test",
      body: "Duplicate",
      idempotencyKey: "key-123",
    });

    expect(r1.messageId).toBe(r2.messageId);
    expect(r1.threadId).toBe(r2.threadId);

    const inbox = mailbox.readInbox({ agent: "b" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toBe("First");
  });
});

describe("body size limit", () => {
  it("rejects oversized messages", () => {
    const bigBody = "x".repeat(100_000);
    expect(() =>
      mailbox.send({ from: "a", to: "b", subject: "Big", body: bigBody })
    ).toThrow(/max size/);
  });
});

describe("rate limiting", () => {
  it("enforces rate limit per agent", () => {
    const fast = new Mailbox({ dbPath: ":memory:", cleanupInterval: 0, rateLimitPerMinute: 3 });

    fast.send({ from: "a", to: "b", subject: "1", body: "1" });
    fast.send({ from: "a", to: "b", subject: "2", body: "2" });
    fast.send({ from: "a", to: "b", subject: "3", body: "3" });

    expect(() =>
      fast.send({ from: "a", to: "b", subject: "4", body: "4" })
    ).toThrow(/Rate limit/);

    // Different agent should still work
    fast.send({ from: "c", to: "b", subject: "5", body: "5" });
    fast.close();
  });
});

describe("broadcast", () => {
  it("sends to broadcast and appears in any agent's inbox", () => {
    mailbox.broadcast({ from: "announcer", subject: "Update", body: "Big news" });

    const inbox1 = mailbox.readInbox({ agent: "agent-1" });
    expect(inbox1).toHaveLength(1);
    expect(inbox1[0].to_agent).toBe("broadcast");
  });
});

describe("threading", () => {
  it("groups messages by thread", () => {
    const r1 = mailbox.send({ from: "a", to: "b", subject: "Topic", body: "First" });
    mailbox.send({ from: "b", to: "a", subject: "Re: Topic", body: "Reply", threadId: r1.threadId });

    const thread = mailbox.getThread(r1.threadId);
    expect(thread).toHaveLength(2);
    expect(thread[0].body).toBe("First");
    expect(thread[1].body).toBe("Reply");
  });

  it("lists threads with counts", () => {
    mailbox.send({ from: "a", to: "b", subject: "Thread 1", body: "msg" });
    mailbox.send({ from: "a", to: "b", subject: "Thread 2", body: "msg" });

    const threads = mailbox.listThreads("b");
    expect(threads).toHaveLength(2);
  });
});

describe("acknowledge", () => {
  it("marks message as acked", () => {
    mailbox.send({ from: "a", to: "b", subject: "Action", body: "Do this" });
    const inbox = mailbox.readInbox({ agent: "b" });
    mailbox.acknowledge(inbox[0].id);

    // Should not appear in unread inbox
    const inbox2 = mailbox.readInbox({ agent: "b" });
    expect(inbox2).toHaveLength(0);
  });

  it("sends reply when acknowledging with response", () => {
    mailbox.send({ from: "a", to: "b", subject: "Question", body: "Why?" });
    const inbox = mailbox.readInbox({ agent: "b" });
    mailbox.acknowledge(inbox[0].id, { from: "b", body: "Because." });

    const inboxA = mailbox.readInbox({ agent: "a" });
    expect(inboxA).toHaveLength(1);
    expect(inboxA[0].subject).toBe("Re: Question");
    expect(inboxA[0].body).toBe("Because.");
  });
});

describe("search", () => {
  it("finds messages by content", () => {
    mailbox.send({ from: "a", to: "b", subject: "API Design", body: "REST endpoints" });
    mailbox.send({ from: "a", to: "b", subject: "Database", body: "Schema migration" });

    const { messages } = mailbox.search({ query: "API" });
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe("API Design");
  });
});

describe("agent registry", () => {
  it("auto-registers agents on send", () => {
    mailbox.send({ from: "bot-1", to: "bot-2", subject: "Hi", body: "Hello" });
    const agents = mailbox.listAgents();
    expect(agents.some((a) => a.name === "bot-1")).toBe(true);
  });

  it("supports manual registration with role", () => {
    mailbox.registerAgent("architect", "Design technical approach");
    const agents = mailbox.listAgents();
    const arch = agents.find((a) => a.name === "architect");
    expect(arch).toBeDefined();
    expect(arch!.role).toBe("Design technical approach");
  });
});

describe("dead letter queue", () => {
  it("lists empty DLQ", () => {
    const dls = mailbox.getDeadLetters();
    expect(dls).toHaveLength(0);
  });
});

describe("metrics", () => {
  it("returns metrics snapshot", () => {
    mailbox.send({ from: "a", to: "b", subject: "Test", body: "msg" });
    const m = mailbox.metrics();
    expect(m.totalMessages).toBe(1);
    expect(m.pendingMessages).toBe(1);
    expect(m.messagesPerAgent["a"]).toBe(1);
  });
});

describe("cleanup", () => {
  it("runs without errors on empty db", () => {
    const result = mailbox.cleanup();
    expect(result.expired).toBe(0);
    expect(result.requeued).toBe(0);
    expect(result.deadLettered).toBe(0);
  });
});

describe("trace_id", () => {
  it("stores and retrieves trace_id", () => {
    mailbox.send({
      from: "a",
      to: "b",
      subject: "Traced",
      body: "msg",
      traceId: "trace-abc-123",
    });

    const inbox = mailbox.readInbox({ agent: "b" });
    expect(inbox[0].trace_id).toBe("trace-abc-123");
  });
});
