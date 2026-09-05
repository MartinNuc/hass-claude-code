"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createApp } = require("../prompt-api.js");
const { ClaudeError } = require("../lib/claude-runner.js");

const TOKEN = "test-token";

async function withServer(opts, fn) {
  const server = createApp({ token: TOKEN, claudeVersion: "2.1.99", ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

const post = (base, body, token = TOKEN) =>
  fetch(`${base}/conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const GOOD = { text: "hi", conversation_id: "c1", model: "sonnet", system_prompt: "sp" };

const health = (base, token = TOKEN) =>
  fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } });

test("GET /health reports the claude version", async () => {
  await withServer({ runTurn: async () => ({}) }, async (base) => {
    const res = await health(base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.claude_version, "2.1.99");
  });
});

test("GET /health rejects a bad token, so the config flow can tell why", async () => {
  await withServer({ runTurn: async () => ({}) }, async (base) => {
    assert.equal((await health(base, "wrong")).status, 401);
  });
});

test("POST /conversation rejects a bad token", async () => {
  await withServer({ runTurn: async () => ({}) }, async (base) => {
    const res = await post(base, GOOD, "wrong");
    assert.equal(res.status, 401);
  });
});

test("POST /conversation rejects a body missing text", async () => {
  await withServer({ runTurn: async () => ({}) }, async (base) => {
    const res = await post(base, { conversation_id: "c1", model: "sonnet", system_prompt: "sp" });
    assert.equal(res.status, 400);
  });
});

test("POST /conversation returns the runner result", async () => {
  const runTurn = async () => ({
    text: "Hello", sessionId: "s1", durationMs: 12, costUsd: 0.01, isError: false,
  });
  await withServer({ runTurn }, async (base) => {
    const res = await post(base, GOOD);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      text: "Hello", session_id: "s1", duration_ms: 12, cost_usd: 0.01, is_error: false,
    });
  });
});

test("POST /conversation passes the request through to the runner", async () => {
  let seen = null;
  const runTurn = async (input) => {
    seen = input;
    return { text: "", sessionId: "s1", durationMs: 0, costUsd: 0, isError: false };
  };
  await withServer({ runTurn }, async (base) => {
    await post(base, GOOD);
    assert.deepEqual(seen, {
      text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp",
    });
  });
});

test("POST /conversation returns 400 for an oversized body instead of a connection error", async () => {
  await withServer({ runTurn: async () => ({}) }, async (base) => {
    const bigText = "x".repeat(2 * 1024 * 1024); // over the 1MB body limit
    const res = await post(base, { ...GOOD, text: bigText });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "payload_too_large" });
  });
});

test("a stalled client that never finishes its body is disconnected within the body timeout", async () => {
  await withServer({ runTurn: async () => ({}), bodyTimeoutMs: 200 }, async (base) => {
    const { port, hostname } = new URL(base);
    const socket = net.connect(Number(port), hostname);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    // Declare a body far bigger than we'll ever send, write just past the
    // 1MB limit, then go silent — no more data, no end(). A well-behaved
    // client never does this; this is the stalled/malicious case.
    const partialBody = "x".repeat(1024 * 1024 + 1024);
    const head =
      "POST /conversation HTTP/1.1\r\n" +
      `Host: ${hostname}\r\n` +
      `Authorization: Bearer ${TOKEN}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 5000000\r\n" +
      "\r\n";

    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write(head + partialBody);

    const start = Date.now();
    await closed;
    const elapsed = Date.now() - start;
    // The injected 200ms bodyTimeoutMs bounds this; give generous slack so
    // the assertion is about "didn't hang", not exact timer precision.
    assert.ok(elapsed < 2000, `expected the stalled connection to close quickly, took ${elapsed}ms`);
    socket.destroy();
  });
});

test("POST /conversation maps a timeout to 504", async () => {
  const runTurn = async () => { throw new ClaudeError("timeout", "too slow"); };
  await withServer({ runTurn }, async (base) => {
    assert.equal((await post(base, GOOD)).status, 504);
  });
});

test("POST /conversation maps other failures to 502", async () => {
  const runTurn = async () => { throw new ClaudeError("failed", "boom"); };
  await withServer({ runTurn }, async (base) => {
    assert.equal((await post(base, GOOD)).status, 502);
  });
});

test("POST /conversation returns 503 past the concurrency cap", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const runTurn = async () => {
    await gate;
    return { text: "", sessionId: "s1", durationMs: 0, costUsd: 0, isError: false };
  };
  await withServer({ runTurn, maxConcurrent: 1 }, async (base) => {
    const first = post(base, GOOD);
    // Give the first request time to occupy the only slot.
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(base, GOOD);
    assert.equal(second.status, 503);
    release();
    assert.equal((await first).status, 200);
  });
});

test("unknown paths return 404", async () => {
  await withServer({ runTurn: async () => ({}) }, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
