"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { buildArgs, createRunner, ClaudeError, EFFORT_LEVELS } = require("../lib/claude-runner.js");
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

test("buildArgs closes the tool surface by default", () => {
  const args = buildArgs({
    text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp", resume: false,
  });
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "sp");
});

test("buildArgs omits --strict-mcp-config so user-registered MCP servers load", () => {
  // Deliberate, not an oversight: that flag is exactly what excludes servers
  // added with `claude mcp add --scope user`, which is how a user extends the
  // Assist agent from the add-on's web terminal.
  const args = buildArgs({
    text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp", resume: false,
  });
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--mcp-config"));
});

test("buildArgs opens web tools only when the agent asks for them", () => {
  const on = buildArgs({
    text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp", resume: false,
    webAccess: true,
  });
  assert.equal(on[on.indexOf("--tools") + 1], "WebSearch,WebFetch");
});

test("buildArgs never admits a code-running tool, whatever it is handed", () => {
  // The tool list is a hardcoded constant precisely so that a bad value
  // upstream cannot widen the surface. Everything here runs unattended at the
  // request of anyone who can speak to a voice satellite, so a Bash that
  // slipped through would be remote code execution by speech.
  for (const webAccess of [true, false, "Bash", "default", 1, {}, ["Bash"]]) {
    const args = buildArgs({
      text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp",
      resume: false, webAccess,
    });
    const tools = args[args.indexOf("--tools") + 1];
    assert.ok(tools === "" || tools === "WebSearch,WebFetch", `leaked: ${tools}`);
  }
});

test("buildArgs passes every effort level claude accepts", () => {
  for (const level of EFFORT_LEVELS) {
    const args = buildArgs({
      text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp",
      resume: false, effort: level,
    });
    assert.equal(args[args.indexOf("--effort") + 1], level, level);
  }
});

test("buildArgs omits --effort for anything claude would not accept", () => {
  // Omitting leaves claude's own default in charge, which is what every agent
  // had before this option existed. Passing junk through would only earn a
  // warning on stderr and the same default, so filtering here keeps the argv
  // honest rather than preventing a failure.
  for (const bad of ["", "bogus", "LOW", " low ", undefined, null, 42, {}, ["low"]]) {
    const args = buildArgs({
      text: "hi", sessionId: "s1", model: "sonnet", systemPrompt: "sp",
      resume: false, effort: bad,
    });
    assert.ok(!args.includes("--effort"), `leaked: ${JSON.stringify(bad)}`);
  }
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

test("runTurn declares the sandbox so bypassPermissions survives running as root", async () => {
  // Not a hypothetical: the add-on container runs as uid 0, and claude 2.1.261
  // refuses bypassPermissions there ("cannot be used with root/sudo
  // privileges"), which killed every Assist turn in production. The fixture
  // only succeeds when IS_SANDBOX reaches the child, so dropping it from the
  // runner's spawn env fails this test rather than silently shipping again.
  const { runner } = runnerWith("root_guard");
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "haiku", systemPrompt: "sp",
  });
  assert.equal(out.text, "Hello from Claude");
  assert.equal(out.isError, false);
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

// Proves the timeout kill reaches the *whole process group*, not just that
// runTurn's promise settles. The "hang" fixture forks a real grandchild
// (a backgrounded `sleep`) and records both its own pid and the grandchild's
// pid to files; after the timeout fires we assert both processes are
// actually gone (process.kill(pid, 0) throws ESRCH), which would fail if the
// process-group kill were deleted or `detached` were flipped to false and
// only the direct child got orphaned/killed.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("runTurn's timeout kills the child's whole process group, including a grandchild", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-"));
  const pidFile = path.join(dir, "pid");
  const childPidFile = path.join(dir, "child-pid");
  const runner = createRunner({
    claudeBin: FAKE,
    workspace: os.tmpdir(),
    timeoutMs: 200,
    env: {
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_PID_FILE: pidFile,
      FAKE_CLAUDE_CHILD_PID_FILE: childPidFile,
    },
  });

  await assert.rejects(
    runner.runTurn({ text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp" }),
    (err) => err instanceof ClaudeError && err.code === "timeout",
  );

  // The pid files are written by the fixture within a few ms of spawn, well
  // before the 200ms timeout fires, so they exist by the time we get here.
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.ok(Number.isInteger(childPid) && childPid > 0);

  // SIGKILL delivery/reaping is async relative to our reject; poll briefly
  // rather than asserting immediately.
  await waitUntil(() => !isAlive(pid) && !isAlive(childPid));
  assert.equal(isAlive(pid), false, "fake-claude process should be killed");
  assert.equal(isAlive(childPid), false, "grandchild (sleep) process should be killed");
});

// A non-zero exit code is not proof that there is nothing to say. The real
// binary exits 1 while still printing a complete result envelope for at least
// two user-reachable cases, and discarding it produced a 502 -> "the Claude
// add-on isn't responding", blaming the add-on for something it did not do.
test("runTurn surfaces the envelope when a budget stop exits non-zero", async () => {
  const { runner } = runnerWith("budget_exhausted");
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp",
  });
  assert.equal(out.isError, true);
  // `result` is null here, so the runner must synthesise something speakable
  // rather than answering the Assist turn with silence.
  assert.equal(out.text, "Claude stopped: error_max_budget_usd");
  assert.equal(out.costUsd, 0.5);
});

test("runTurn surfaces the envelope when the model id is not recognized", async () => {
  const { runner } = runnerWith("unrecognized_model");
  const out = await runner.runTurn({
    text: "hi", conversationId: "c1", model: "bogus-model-xyz", systemPrompt: "sp",
  });
  assert.equal(out.isError, true);
  assert.equal(out.text, "Unrecognized model: bogus-model-xyz");
});

test("runTurn still throws when a non-zero exit leaves no usable envelope", async () => {
  const { runner } = runnerWith("hard_fail");
  await assert.rejects(
    runner.runTurn({ text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp" }),
    (err) => err instanceof ClaudeError && err.code === "failed"
      && /something went very wrong/.test(err.message),
  );
});

test("runTurn throws on unparseable output", async () => {
  const { runner } = runnerWith("garbage");
  await assert.rejects(
    runner.runTurn({ text: "hi", conversationId: "c1", model: "sonnet", systemPrompt: "sp" }),
    (err) => err instanceof ClaudeError && err.code === "failed",
  );
});
