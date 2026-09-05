"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
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
