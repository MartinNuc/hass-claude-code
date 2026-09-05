"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { buildArgs, createRunner, ClaudeError } = require("../lib/claude-runner.js");
const { SessionTracker } = require("../lib/session-map.js");

const FAKE = path.join(__dirname, "fixtures", "fake-claude");

function runnerWith(mode, extra = {}) {
  const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fc-")), "argv");
  const runner = createRunner({
    claudeBin: FAKE,
    workspace: os.tmpdir(),
    env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_ARGV_FILE: argvFile },
    ...extra,
  });
  return { runner, argv: () => fs.readFileSync(argvFile, "utf8").split("\n").slice(0, -1) };
}

test("buildArgs uses --session-id for a first turn", () => {
  const args = buildArgs({
    text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp", resume: false,
  });
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("--resume"));
});

test("buildArgs uses --resume for a later turn", () => {
  const args = buildArgs({
    text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp", resume: true,
  });
  assert.ok(args.includes("--resume"));
  assert.ok(!args.includes("--session-id"));
});

test("buildArgs closes the tool surface", () => {
  const args = buildArgs({
    text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp", resume: false,
  });
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "sp");
});

test("runTurn returns the parsed envelope", async () => {
  const { runner } = runnerWith("success");
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp",
  });
  assert.equal(out.text, "Hello from Claude");
  assert.equal(out.isError, false);
  assert.equal(out.costUsd, 0.004);
});

test("runTurn surfaces is_error results without throwing", async () => {
  const { runner } = runnerWith("error_result");
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp",
  });
  assert.equal(out.isError, true);
  assert.equal(out.text, "I cannot see that entity");
});

test("runTurn uses --resume once a conversation is known", async () => {
  const { runner, argv } = runnerWith("success");
  const input = { text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp" };
  await runner.runTurn(input);
  assert.ok(argv().includes("--session-id"));
  await runner.runTurn(input);
  assert.ok(argv().includes("--resume"));
});

test("runTurn falls back to --session-id when the session is gone", async () => {
  const tracker = new SessionTracker();
  let call = 0;
  const runner = createRunner({
    claudeBin: FAKE,
    workspace: os.tmpdir(),
    tracker,
    env: () => (call++ === 0
      ? { FAKE_CLAUDE_MODE: "resume_missing" }
      : { FAKE_CLAUDE_MODE: "success" }),
  });
  tracker.mark(require("../lib/session-map.js").sessionIdFor("c1"));
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp",
  });
  assert.equal(out.text, "Hello from Claude");
  assert.equal(call, 2);
});

test("runTurn falls back to --resume when the session already exists", async () => {
  let call = 0;
  const runner = createRunner({
    claudeBin: FAKE,
    workspace: os.tmpdir(),
    env: () => (call++ === 0
      ? { FAKE_CLAUDE_MODE: "session_in_use" }
      : { FAKE_CLAUDE_MODE: "success" }),
  });
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp",
  });
  assert.equal(out.text, "Hello from Claude");
  assert.equal(call, 2);
});

test("runTurn throws a timeout error and does not hang", async () => {
  const { runner } = runnerWith("hang", { timeoutMs: 200 });
  await assert.rejects(
    runner.runTurn({ text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp" }),
    (err) => err instanceof ClaudeError && err.code === "timeout",
  );
});

test("runTurn throws on unparseable output", async () => {
  const { runner } = runnerWith("garbage");
  await assert.rejects(
    runner.runTurn({ text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp" }),
    (err) => err instanceof ClaudeError && err.code === "failed",
  );
});
