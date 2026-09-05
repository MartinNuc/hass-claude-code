# Claude Assist Conversation Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Home Assistant's Assist a Claude conversation agent, by routing each turn through `claude -p` inside this add-on with a per-agent model setting.

**Architecture:** A HA custom integration runs in the HA Core container, which has no `claude` binary, so it calls a small HTTP prompt API in the add-on container. That API spawns `claude -p --output-format json`, which reaches back into HA over MCP (`/api/mcp/assist`) for tool use. HA builds the system prompt including the exposed-entity list; Claude executes tools itself, so the integration makes one request per turn and never runs a tool loop.

**Tech Stack:** Node.js (add-on side, standard library only, `node --test`), Python / Home Assistant custom integration (config entry + conversation subentries, `pytest-homeassistant-custom-component`), s6 services, Alpine + bashio.

**Spec:** `docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md`

## Global Constraints

- Claude Code **>= 2.1.80**, already enforced at image build time in `Dockerfile`. Do not weaken that check.
- **No new npm dependencies** in `app/`. The prompt API uses `http`, `child_process` and `crypto` only. Tests use the built-in `node --test` runner.
- **No secret in the image or in git.** Tokens are generated at runtime into `/data` or read from add-on options.
- The Assist `claude` invocation always passes `--tools ""` and `--strict-mcp-config`, so its entire capability is the HA Assist MCP server. Never add a built-in tool back.
- Integration domain is `claude_code_conversation`; it lives at `custom_components/claude_code_conversation/` in this repo and is copied into the HA config dir by the add-on.
- The integration declares `"single_config_entry": true` — one add-on, one connection.
- Conversation agents are **subentries** of type `"conversation"`, following `homeassistant/components/ollama` and `open_router` in HA core. Do not use an options flow.
- `CONF_LLM_HASS_API` is pinned to `[llm.LLM_API_ASSIST]` in code and never exposed in a form.
- Prompt API listens on port **8098**, Supervisor network only. Do **not** add a `ports:` mapping to `config.yaml`.

### Verified `claude -p` behaviour (do not re-derive)

Success envelope on stdout, exit 0 — the fields this project uses:

```json
{"type":"result","subtype":"success","is_error":false,"result":"OK",
 "session_id":"7f0eec46-...","duration_ms":969,"total_cost_usd":0.003068}
```

Failure modes, both **exit code 1 with empty stdout**:

| stderr (exact) | Meaning |
|---|---|
| `No conversation found with session ID: <uuid>` | `--resume` on a session that does not exist |
| `Error: Session ID <uuid> is already in use.` | `--session-id` on a session that already exists |

`--resume` preserves conversation history and returns the **same** `session_id`.

---

### Task 1: Spike — how the add-on authenticates to HA's MCP server

No code is written in this task. It answers spec §11.1 and §11.2, and its answer
decides the body of `20-mcp-assist.sh` in Task 5.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md` (record the answer in §11)

- [ ] **Step 1: Enable HA's MCP Server integration**

In Home Assistant: **Settings → Devices & Services → Add Integration → Model
Context Protocol Server**. Accept the default, which selects the **Assist** LLM
API. Confirm that at least one entity is exposed to Assist under
**Settings → Voice assistants → Expose**, otherwise the server has no tools and
the spike cannot distinguish "no auth" from "no entities".

- [ ] **Step 2: Open a shell inside the add-on**

Open the add-on's **Web UI** tab (the ttyd terminal on port 7681).

- [ ] **Step 3: Try the Supervisor token against the direct core URL**

```bash
curl -isS -X POST \
  -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"spike","version":"0"}}}' \
  http://homeassistant:8123/api/mcp/assist | head -40
```

Expected if it works: `HTTP/1.1 200 OK` and a JSON-RPC result naming the server.
Expected if it does not: `401 Unauthorized`.

- [ ] **Step 4: If Step 3 returned 401, try the Supervisor core proxy**

```bash
curl -isS -X POST \
  -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"spike","version":"0"}}}' \
  http://supervisor/core/api/mcp/assist | head -40
```

- [ ] **Step 5: If both returned 401, confirm a long-lived token works**

Create one in HA under **Profile → Security → Long-lived access tokens**, then
repeat Step 3 with `Authorization: Bearer <that token>`. This must succeed; if it
does not, the MCP Server integration is not set up correctly — return to Step 1.

- [ ] **Step 6: Verify Claude Code can actually speak to it**

Using whichever URL and token succeeded:

```bash
cat > /tmp/mcp-spike.json <<EOF
{"mcpServers":{"ha-assist":{"type":"http","url":"<URL FROM ABOVE>",
 "headers":{"Authorization":"Bearer <TOKEN FROM ABOVE>"}}}}
EOF

claude -p "List the tools you have available. Do not call any of them." \
  --output-format json --model haiku \
  --mcp-config /tmp/mcp-spike.json --strict-mcp-config \
  --tools "" --permission-mode bypassPermissions --setting-sources ""
```

Expected: `"is_error": false` and a `result` naming HA intent tools such as
`HassTurnOn` / `GetLiveContext`. If `result` says it has no tools, the MCP
connection failed — re-check the URL and header.

Delete `/tmp/mcp-spike.json` afterwards; it contains a token.

- [ ] **Step 7: Record the answer in the spec**

Replace spec §11 questions 1 and 2 with the finding, in this form:

```markdown
1. **Answered 2026-09-05.** `/api/mcp/assist` accepts `SUPERVISOR_TOKEN` at
   `http://homeassistant:8123/api/mcp/assist` — no user-supplied token needed on
   HAOS. (Or: does not; the add-on requires the `ha_mcp_token` option.)
2. **Answered 2026-09-05.** MCP streaming works through <the URL that worked>.
```

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md
git commit -m "docs: record MCP auth spike result"
```

---

### Task 2: Session id mapping

Maps HA's `conversation_id` to a stable Claude session UUID, and remembers which
sessions have been started so later turns can use `--resume`.

**Files:**
- Create: `app/lib/session-map.js`
- Create: `app/test/session-map.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sessionIdFor(conversationId: string) -> string` (a v5 UUID)
  - `class SessionTracker { constructor({ttlMs?, maxEntries?, now?}); isKnown(sessionId): boolean; mark(sessionId): void; forget(sessionId): void }`

- [ ] **Step 1: Write the failing test**

Create `app/test/session-map.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sessionIdFor, SessionTracker } = require("../lib/session-map.js");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("sessionIdFor is deterministic", () => {
  assert.equal(sessionIdFor("01JABCD"), sessionIdFor("01JABCD"));
});

test("sessionIdFor produces a valid v5 UUID", () => {
  assert.match(sessionIdFor("01JABCD"), UUID_RE);
});

test("sessionIdFor separates different conversations", () => {
  assert.notEqual(sessionIdFor("01JABCD"), sessionIdFor("01JABCE"));
});

test("tracker reports unknown sessions as unknown", () => {
  const t = new SessionTracker();
  assert.equal(t.isKnown("abc"), false);
});

test("tracker remembers a marked session", () => {
  const t = new SessionTracker();
  t.mark("abc");
  assert.equal(t.isKnown("abc"), true);
});

test("tracker forgets a session on demand", () => {
  const t = new SessionTracker();
  t.mark("abc");
  t.forget("abc");
  assert.equal(t.isKnown("abc"), false);
});

test("tracker expires entries past the ttl", () => {
  let clock = 1000;
  const t = new SessionTracker({ ttlMs: 500, now: () => clock });
  t.mark("abc");
  clock = 1400;
  assert.equal(t.isKnown("abc"), true);
  clock = 1600;
  assert.equal(t.isKnown("abc"), false);
});

test("tracker evicts the oldest entry past maxEntries", () => {
  let clock = 0;
  const t = new SessionTracker({ maxEntries: 2, now: () => clock++ });
  t.mark("a");
  t.mark("b");
  t.mark("c");
  assert.equal(t.isKnown("a"), false);
  assert.equal(t.isKnown("c"), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && node --test test/session-map.test.js`
Expected: FAIL — `Cannot find module '../lib/session-map.js'`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/session-map.js`:

```js
"use strict";
// Maps a Home Assistant conversation_id (a ULID) onto a stable Claude session
// UUID, so turn 2 of a conversation can --resume turn 1.

const crypto = require("crypto");

// Any fixed v4 UUID works as the namespace. It only has to stay constant
// across restarts so the same conversation_id always yields the same session.
const NAMESPACE = "6f1d5b2c-9a3e-4f18-8c71-2b4a0d6e5c93";

function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto
    .createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return [
    h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20),
  ].join("-");
}

function sessionIdFor(conversationId) {
  return uuidv5(String(conversationId), NAMESPACE);
}

// Remembers which session ids have been started. Purely a fast path: if this
// is wrong (add-on restarted, /data wiped) claude-runner recovers by retrying
// with the other flag. Bounded so a long-lived process cannot grow forever.
class SessionTracker {
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 200, now = Date.now } = {}) {
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._now = now;
    this._seen = new Map(); // sessionId -> lastSeenMs
  }

  isKnown(sessionId) {
    const seenAt = this._seen.get(sessionId);
    if (seenAt === undefined) return false;
    if (this._now() - seenAt > this._ttlMs) {
      this._seen.delete(sessionId);
      return false;
    }
    return true;
  }

  mark(sessionId) {
    this._seen.delete(sessionId); // re-insert so Map order is oldest-first
    this._seen.set(sessionId, this._now());
    while (this._seen.size > this._maxEntries) {
      const oldest = this._seen.keys().next().value;
      this._seen.delete(oldest);
    }
  }

  forget(sessionId) {
    this._seen.delete(sessionId);
  }
}

module.exports = { sessionIdFor, SessionTracker };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && node --test test/session-map.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/session-map.js app/test/session-map.test.js
git commit -m "feat(addon): map HA conversation ids to stable Claude session ids"
```

---

### Task 3: Claude runner

Builds the `claude -p` argv, spawns it with a timeout, parses the envelope, and
recovers from both session-flag failure modes.

**Files:**
- Create: `app/lib/claude-runner.js`
- Create: `app/test/claude-runner.test.js`
- Create: `app/test/fixtures/fake-claude`

**Interfaces:**
- Consumes: `sessionIdFor`, `SessionTracker` from `app/lib/session-map.js` (Task 2).
- Produces:
  - `buildArgs({text, sessionId, model, systemPrompt, resume}) -> string[]`
  - `class ClaudeError extends Error { code: "timeout" | "resume_missing" | "session_in_use" | "failed" }`
  - `createRunner({tracker?, spawnFn?, timeoutMs?, claudeBin?, workspace?, mcpConfig?, maxBudgetUsd?}) -> { runTurn }`
  - `runTurn({text, conversationId, model, systemPrompt}) -> Promise<{text, sessionId, durationMs, costUsd, isError}>`

- [ ] **Step 1: Write the fake `claude` fixture**

Create `app/test/fixtures/fake-claude`:

```sh
#!/bin/sh
# Stand-in for the real claude binary. Behaviour is switched by env vars so a
# single fixture covers every case the runner must handle.
if [ -n "$FAKE_CLAUDE_ARGV_FILE" ]; then
  : > "$FAKE_CLAUDE_ARGV_FILE"
  for a in "$@"; do printf '%s\n' "$a" >> "$FAKE_CLAUDE_ARGV_FILE"; done
fi

case "${FAKE_CLAUDE_MODE:-success}" in
  success)
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"Hello from Claude","session_id":"sess-1","duration_ms":123,"total_cost_usd":0.004}'
    exit 0 ;;
  error_result)
    printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"I cannot see that entity","session_id":"sess-1","duration_ms":50,"total_cost_usd":0.001}'
    exit 0 ;;
  resume_missing)
    echo "No conversation found with session ID: sess-1" >&2
    exit 1 ;;
  session_in_use)
    echo "Error: Session ID sess-1 is already in use." >&2
    exit 1 ;;
  garbage)
    printf '%s\n' 'not json at all'
    exit 0 ;;
  hang)
    sleep 300 ;;
esac
```

Then: `chmod +x app/test/fixtures/fake-claude`

Note the `resume_missing` / `session_in_use` strings are copied verbatim from
real `claude` output — see "Verified `claude -p` behaviour" above.

- [ ] **Step 2: Write the failing test**

Create `app/test/claude-runner.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd app && node --test test/claude-runner.test.js`
Expected: FAIL — `Cannot find module '../lib/claude-runner.js'`.

- [ ] **Step 4: Write the implementation**

Create `app/lib/claude-runner.js`:

```js
"use strict";
// Spawns `claude -p` for one Assist turn and normalises the result.
//
// The Assist session is deliberately the narrowest thing Claude Code can be:
// --tools "" removes every built-in tool and --strict-mcp-config limits MCP to
// the HA Assist server, so the whole capability surface is HA's own intents.
// There is no deny-list to keep in sync as Claude Code grows new tools.

const { spawn } = require("child_process");
const { sessionIdFor, SessionTracker } = require("./session-map.js");

const RESUME_MISSING_RE = /No conversation found with session ID/i;
const SESSION_IN_USE_RE = /Session ID .* is already in use/i;

class ClaudeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaudeError";
    this.code = code; // "timeout" | "resume_missing" | "session_in_use" | "failed"
  }
}

function buildArgs({ text, sessionId, model, systemPrompt, resume, mcpConfig, maxBudgetUsd }) {
  return [
    "-p", text,
    "--output-format", "json",
    "--model", model,
    resume ? "--resume" : "--session-id", sessionId,
    "--system-prompt", systemPrompt,
    // Record the prompt once per conversation and reuse it on resume: cheaper,
    // and keeps every turn of one conversation on identical instructions.
    "--system-prompt-snapshot", "on",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--tools", "",
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--max-budget-usd", String(maxBudgetUsd),
  ];
}

function createRunner({
  tracker = new SessionTracker(),
  spawnFn = spawn,
  timeoutMs = Number(process.env.ASSIST_TIMEOUT_MS || 60000),
  claudeBin = process.env.CLAUDE_BIN || "claude",
  workspace = process.env.ASSIST_WORKSPACE || "/data/assist-workspace",
  mcpConfig = process.env.ASSIST_MCP_CONFIG || "/data/.claude/mcp-assist.json",
  maxBudgetUsd = process.env.ASSIST_MAX_BUDGET_USD || "0.50",
  env = {},
} = {}) {
  const extraEnv = () => (typeof env === "function" ? env() : env);

  function spawnOnce(args) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(claudeBin, args, {
        cwd: workspace,
        env: { ...process.env, HOME: "/root", ...extraEnv() },
        // Own process group, so the timeout can kill claude *and* the MCP
        // subprocesses it started rather than orphaning them.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        reject(new ClaudeError("timeout", `claude exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ClaudeError("failed", `could not start claude: ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          if (RESUME_MISSING_RE.test(stderr)) {
            return reject(new ClaudeError("resume_missing", stderr.trim()));
          }
          if (SESSION_IN_USE_RE.test(stderr)) {
            return reject(new ClaudeError("session_in_use", stderr.trim()));
          }
          return reject(new ClaudeError("failed", stderr.trim() || `claude exited ${code}`));
        }
        let envelope;
        try {
          envelope = JSON.parse(stdout);
        } catch {
          return reject(new ClaudeError("failed", `unparseable claude output: ${stdout.slice(0, 200)}`));
        }
        resolve(envelope);
      });
    });
  }

  async function runTurn({ text, conversationId, model, systemPrompt }) {
    const sessionId = sessionIdFor(conversationId);
    const base = { text, sessionId, model, systemPrompt, mcpConfig, maxBudgetUsd };
    let resume = tracker.isKnown(sessionId);

    let envelope;
    try {
      envelope = await spawnOnce(buildArgs({ ...base, resume }));
    } catch (err) {
      // Our idea of whether this session exists can be wrong in both
      // directions: the add-on may have restarted (we forgot a live session),
      // or /data may have been cleared (we remember a dead one). Both are
      // recoverable by flipping the flag exactly once.
      if (!(err instanceof ClaudeError)) throw err;
      if (err.code !== "resume_missing" && err.code !== "session_in_use") throw err;
      resume = !resume;
      envelope = await spawnOnce(buildArgs({ ...base, resume }));
    }

    tracker.mark(sessionId);
    return {
      text: typeof envelope.result === "string" ? envelope.result : "",
      sessionId: envelope.session_id || sessionId,
      durationMs: envelope.duration_ms ?? null,
      costUsd: envelope.total_cost_usd ?? null,
      isError: Boolean(envelope.is_error),
    };
  }

  return { runTurn };
}

module.exports = { buildArgs, createRunner, ClaudeError };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd app && node --test test/claude-runner.test.js`
Expected: PASS, 10 tests. The timeout test should finish in well under a second
— if it takes 300s the process-group kill is broken.

- [ ] **Step 6: Commit**

```bash
git add app/lib/claude-runner.js app/test/claude-runner.test.js app/test/fixtures/fake-claude
git commit -m "feat(addon): spawn claude -p for one Assist turn with session recovery"
```

---

### Task 4: Prompt API HTTP server

**Files:**
- Create: `app/prompt-api.js`
- Create: `app/test/prompt-api.test.js`
- Modify: `app/package.json` (add a `test` script)

**Interfaces:**
- Consumes: `createRunner` from `app/lib/claude-runner.js` (Task 3).
- Produces:
  - `createApp({runTurn, token, claudeVersion, maxConcurrent}) -> http.Server`
  - HTTP contract: `GET /health -> 200 {ok, claude_version}`;
    `POST /conversation {text, conversation_id, model, system_prompt}` ->
    `200 {text, session_id, duration_ms, cost_usd, is_error}`,
    `401` bad token, `400` bad body, `503` at capacity, `504` timeout, `502` other failure.

- [ ] **Step 1: Write the failing test**

Create `app/test/prompt-api.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && node --test test/prompt-api.test.js`
Expected: FAIL — `Cannot find module '../prompt-api.js'`.

- [ ] **Step 3: Write the implementation**

Create `app/prompt-api.js`:

```js
"use strict";
// HTTP front door for the Assist conversation agent.
//
// Home Assistant custom integrations run in the HA Core container, which has no
// claude binary. This service is how the integration reaches one. It listens on
// the Supervisor network only — config.yaml deliberately maps no port.

const http = require("http");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { createRunner, ClaudeError } = require("./lib/claude-runner.js");

const PORT = Number(process.env.PROMPT_API_PORT || 8098);
const TOKEN_FILE = process.env.PROMPT_API_TOKEN_FILE || "/data/prompt-api-token";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function createApp({ runTurn, token, claudeVersion, maxConcurrent = 2 }) {
  let inFlight = 0;

  return http.createServer(async (req, res) => {
    const path = req.url.split("?")[0];

    const isHealth = req.method === "GET" && path === "/health";
    const isConversation = req.method === "POST" && path === "/conversation";

    if (!isHealth && !isConversation) {
      return json(res, 404, { error: "not_found" });
    }

    // Both endpoints require the token, so the config flow can tell a wrong
    // URL (connection error) apart from a wrong token (401) by calling
    // /health alone.
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (isHealth) {
      return json(res, 200, { ok: true, claude_version: claudeVersion });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }

    const { text, conversation_id: conversationId, model, system_prompt: systemPrompt } = body;
    if (typeof text !== "string" || !text
      || typeof conversationId !== "string" || !conversationId
      || typeof model !== "string" || !model) {
      return json(res, 400, { error: "invalid_request" });
    }

    // Each claude process holds a model connection and its own MCP client, so
    // an unbounded queue would take the whole add-on down on a Pi. Shedding
    // load with 503 lets the integration say "busy, try again" instead.
    if (inFlight >= maxConcurrent) {
      return json(res, 503, { error: "busy" });
    }

    inFlight += 1;
    try {
      const result = await runTurn({
        text,
        conversationId,
        model,
        systemPrompt: typeof systemPrompt === "string" ? systemPrompt : "",
      });
      return json(res, 200, {
        text: result.text,
        session_id: result.sessionId,
        duration_ms: result.durationMs,
        cost_usd: result.costUsd,
        is_error: result.isError,
      });
    } catch (err) {
      const status = err instanceof ClaudeError && err.code === "timeout" ? 504 : 502;
      console.error(`[prompt-api] turn failed: ${err.message}`);
      return json(res, status, { error: err.code || "failed", detail: err.message });
    } finally {
      inFlight -= 1;
    }
  });
}

function detectClaudeVersion() {
  try {
    const out = execFileSync(process.env.CLAUDE_BIN || "claude", ["--version"], {
      encoding: "utf8",
    });
    return (out.match(/\d+\.\d+\.\d+/) || ["unknown"])[0];
  } catch {
    return "unknown";
  }
}

function main() {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const { runTurn } = createRunner();
  const server = createApp({ runTurn, token, claudeVersion: detectClaudeVersion() });
  server.listen(PORT, () => console.log(`[prompt-api] listening on :${PORT}`));
}

if (require.main === module) main();

module.exports = { createApp };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && node --test test/prompt-api.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add a test script and run the whole add-on suite**

In `app/package.json`, add a `scripts` block beside the existing `dependencies`:

```json
  "scripts": {
    "test": "node --test test/"
  },
```

Run: `cd app && npm test`
Expected: PASS, 28 tests across three files.

- [ ] **Step 6: Commit**

```bash
git add app/prompt-api.js app/test/prompt-api.test.js app/package.json
git commit -m "feat(addon): HTTP prompt API for the Assist conversation agent"
```

---

### Task 5: Add-on wiring — s6 service, init scripts, image, options

Everything in this task is verified by `docker build` plus a manual smoke test,
not by unit tests: these are container-init shell scripts whose only real
substrate is a running Supervisor. Keep them thin for exactly that reason — all
branching logic belongs in the Node modules that Tasks 2-4 covered with tests.

**Files:**
- Create: `rootfs/etc/services.d/prompt-api/run`
- Create: `rootfs/etc/services.d/prompt-api/finish`
- Create: `rootfs/etc/cont-init.d/20-mcp-assist.sh`
- Create: `rootfs/etc/cont-init.d/30-deploy-integration.sh`
- Modify: `Dockerfile` (chmod list)
- Modify: `config.yaml` (version bump, new option)

- [ ] **Step 1: Write the prompt-api s6 service**

Create `rootfs/etc/services.d/prompt-api/run`:

```bash
#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# HTTP prompt API consumed by the claude_code_conversation custom integration.
export PATH="/opt/bun/bin:/root/.local/bin:${PATH}"

if [[ ! -f "/data/.claude/.credentials.json" ]]; then
  bashio::log.warning "prompt-api: Claude is not authenticated yet; retrying in 60s."
  sleep 60
  exit 1
fi

exec 2>&1
exec node /app/prompt-api.js
```

Create `rootfs/etc/services.d/prompt-api/finish`:

```bash
#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
bashio::log.warning "prompt-api exited with code ${1}; s6 will restart it."
```

- [ ] **Step 2: Write the MCP config init script**

Create `rootfs/etc/cont-init.d/20-mcp-assist.sh`. Use whichever URL and token
Task 1 established; the version below assumes the `SUPERVISOR_TOKEN` path
worked, with the add-on option as the override.

```bash
#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# MCP config for the Assist conversation agent ONLY.
#
# Deliberately separate from /data/.claude/mcp.json: the Assist agent gets
# Home Assistant's own intent tools, scoped to entities exposed to Assist,
# while the interactive Remote Control session keeps the full vibecode-agent
# surface. Neither inherits the other's tools.

mkdir -p /data/assist-workspace

MCP_URL="http://homeassistant:8123/api/mcp/assist"
MCP_TOKEN="${SUPERVISOR_TOKEN}"

if bashio::config.has_value 'ha_mcp_token'; then
  MCP_TOKEN="$(bashio::config 'ha_mcp_token')"
  bashio::log.info "Using the configured long-lived token for the HA MCP server."
else
  bashio::log.info "Using the Supervisor token for the HA MCP server."
fi

jq -n \
  --arg url "${MCP_URL}" \
  --arg auth "Bearer ${MCP_TOKEN}" \
  '{mcpServers: {"ha-assist": {type: "http", url: $url, headers: {Authorization: $auth}}}}' \
  > /data/.claude/mcp-assist.json
chmod 600 /data/.claude/mcp-assist.json

bashio::log.info "Assist MCP config written (${MCP_URL})."
```

- [ ] **Step 3: Write the integration deploy script**

Create `rootfs/etc/cont-init.d/30-deploy-integration.sh`:

```bash
#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# Deploy the custom integration into the user's HA config directory.
#
# The integration and the prompt API are two halves of one contract, so
# shipping them together removes any chance of version skew. It also spares the
# user a HACS install, and lets us hand the config flow a discovery file
# containing this add-on's Supervisor hostname — which the integration running
# inside HA Core cannot otherwise guess.

SRC="/app/custom_components/claude_code_conversation"
DEST_DIR="/homeassistant/custom_components"
DEST="${DEST_DIR}/claude_code_conversation"

TOKEN_FILE="/data/prompt-api-token"
if [[ ! -f "${TOKEN_FILE}" ]]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  bashio::log.info "Generated a prompt API token."
fi
TOKEN="$(cat "${TOKEN_FILE}")"

SRC_VERSION="$(jq -r '.version' "${SRC}/manifest.json")"
DEST_VERSION="$(jq -r '.version' "${DEST}/manifest.json" 2>/dev/null || echo "none")"

if [[ "${SRC_VERSION}" != "${DEST_VERSION}" ]]; then
  bashio::log.info "Deploying claude_code_conversation ${DEST_VERSION} -> ${SRC_VERSION}"
  mkdir -p "${DEST_DIR}"
  rm -rf "${DEST}"
  cp -r "${SRC}" "${DEST}"
  bashio::log.warning "════════════════════════════════════════════════════"
  bashio::log.warning "Restart Home Assistant to load the Claude Assist"
  bashio::log.warning "integration, then add it under Settings → Devices."
  bashio::log.warning "════════════════════════════════════════════════════"
else
  bashio::log.info "claude_code_conversation ${SRC_VERSION} already deployed."
fi

# Always refresh discovery: the hostname is stable but the token may have just
# been generated, and the config flow reads this file to pre-fill its form.
jq -n \
  --arg url "http://$(hostname):8098" \
  --arg token "${TOKEN}" \
  '{base_url: $url, token: $token}' \
  > "${DEST}/.addon.json"
chmod 600 "${DEST}/.addon.json"
```

- [ ] **Step 4: Add the new option to `config.yaml`**

Bump `version` to `1.6.0`, and extend the `options` and `schema` blocks (keep
the existing `ha_agent_url` / `ha_agent_key` entries as they are):

```yaml
options:
  ha_agent_url: ""
  ha_agent_key: ""
  ha_mcp_token: ""

schema:
  ha_agent_url: str?
  ha_agent_key: str
  ha_mcp_token: str?
```

Do **not** add a `ports:` block. Port 8098 stays on the Supervisor network.

- [ ] **Step 5: Wire the new files into the image**

In `Dockerfile`, extend the existing `RUN chmod +x \` list with the four new
paths, so it reads:

```dockerfile
RUN chmod +x \
    /etc/cont-init.d/10-setup.sh \
    /etc/cont-init.d/20-mcp-assist.sh \
    /etc/cont-init.d/30-deploy-integration.sh \
    /etc/services.d/claude/run \
    /etc/services.d/claude/finish \
    /etc/services.d/ttyd/run \
    /etc/services.d/ttyd/finish \
    /etc/services.d/prompt-api/run \
    /etc/services.d/prompt-api/finish \
    /app/start.sh \
    /app/claude-daemon.js \
    /app/prompt-api.js
```

The existing `COPY app /app` already carries `app/prompt-api.js` and
`app/lib/`. Add one line directly after it so the integration ships in the
image where `30-deploy-integration.sh` expects it:

```dockerfile
COPY custom_components /app/custom_components
```

- [ ] **Step 6: Verify the scripts and build the image**

```bash
shellcheck -s bash rootfs/etc/cont-init.d/20-mcp-assist.sh \
                   rootfs/etc/cont-init.d/30-deploy-integration.sh \
                   rootfs/etc/services.d/prompt-api/run \
                   rootfs/etc/services.d/prompt-api/finish
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21 -t claude-addon-test .
```

Expected: shellcheck clean (the `#!/usr/bin/with-contenv bashio` shebang is why
`-s bash` is passed explicitly), and the build succeeds.

This step depends on Task 6 having created `custom_components/`, so if you are
executing tasks strictly in order, run the build after Task 6 and only
shellcheck here.

- [ ] **Step 7: Commit**

```bash
git add rootfs/etc/services.d/prompt-api rootfs/etc/cont-init.d/20-mcp-assist.sh \
        rootfs/etc/cont-init.d/30-deploy-integration.sh Dockerfile config.yaml
git commit -m "feat(addon): run the prompt API and deploy the Assist integration"
```

---

### Task 6: Integration package, API client, and entry setup

**Files:**
- Create: `custom_components/claude_code_conversation/manifest.json`
- Create: `custom_components/claude_code_conversation/const.py`
- Create: `custom_components/claude_code_conversation/client.py`
- Create: `custom_components/claude_code_conversation/__init__.py`
- Create: `tests/conftest.py`
- Create: `tests/test_init.py`
- Create: `requirements_test.txt`
- Create: `pytest.ini`

**Interfaces:**
- Consumes: the HTTP contract from Task 4.
- Produces:
  - `const.py`: `DOMAIN = "claude_code_conversation"`, `CONF_BASE_URL`, `CONF_TOKEN`, `CONF_NAME`, `MODELS`, `RECOMMENDED_MODEL`, `DEFAULT_TIMEOUT`
  - `client.py`: `PromptApiClient(base_url, token, session)` with
    `async_health() -> dict` and
    `async_converse(text, conversation_id, model, system_prompt) -> ConverseResult`;
    exceptions `PromptApiError`, `PromptApiAuthError`, `PromptApiBusyError`, `PromptApiTimeoutError`;
    dataclass `ConverseResult(text: str, session_id: str, is_error: bool)`
  - `__init__.py`: `ClaudeCodeData(client, claude_version)`, `type ClaudeCodeConfigEntry = ConfigEntry[ClaudeCodeData]`

- [ ] **Step 1: Create the Python test environment**

```bash
python3 -m venv .venv
.venv/bin/pip install pytest-homeassistant-custom-component aioresponses
.venv/bin/pip freeze | grep -E '^(pytest-homeassistant-custom-component|homeassistant|aioresponses)=' > requirements_test.txt
cat requirements_test.txt
```

Pinning the resolved versions matters: `pytest-homeassistant-custom-component`
is tied to one exact `homeassistant` release, and an unpinned upgrade will break
the suite with confusing import errors.

Create `pytest.ini`:

```ini
[pytest]
testpaths = tests
asyncio_mode = auto
```

Add `.venv/` to `.gitignore` if it is not already covered.

- [ ] **Step 2: Write the failing test**

Create `tests/conftest.py`:

```python
"""Shared fixtures for the claude_code_conversation tests."""

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.claude_code_conversation.const import (
    CONF_BASE_URL,
    CONF_TOKEN,
    DOMAIN,
)

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load custom_components/ during tests."""
    return


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """A configured connection to the add-on's prompt API."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Claude Code Agent",
        data={CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"},
    )
```

Create `tests/test_init.py`:

```python
"""Tests for setting up the claude_code_conversation config entry."""

from aioresponses import aioresponses

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

HEALTH_URL = "http://addon:8098/health"


async def test_setup_entry_succeeds(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """A healthy add-on results in a loaded entry carrying the claude version."""
    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert mock_config_entry.runtime_data.claude_version == "2.1.99"


async def test_setup_entry_retries_when_addon_is_down(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """An unreachable add-on leaves the entry retrying, not failed."""
    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=500)
        await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY


async def test_unload_entry(hass: HomeAssistant, mock_config_entry) -> None:
    """The entry unloads cleanly."""
    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert await hass.config_entries.async_unload(mock_config_entry.entry_id)
    assert mock_config_entry.state is ConfigEntryState.NOT_LOADED
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest tests/test_init.py -v`
Expected: FAIL — `ModuleNotFoundError: custom_components.claude_code_conversation.const`.

- [ ] **Step 4: Write the implementation**

Create `custom_components/claude_code_conversation/manifest.json`:

```json
{
  "domain": "claude_code_conversation",
  "name": "Claude Code Agent",
  "after_dependencies": ["assist_pipeline", "intent"],
  "codeowners": ["@MartinNuc"],
  "config_flow": true,
  "dependencies": ["conversation"],
  "documentation": "https://github.com/MartinNuc/hass-claude-code",
  "integration_type": "service",
  "iot_class": "local_polling",
  "single_config_entry": true,
  "version": "1.0.0"
}
```

Create `custom_components/claude_code_conversation/const.py`:

```python
"""Constants for the Claude Code Agent conversation integration."""

import logging

DOMAIN = "claude_code_conversation"
LOGGER = logging.getLogger(__package__)

CONF_BASE_URL = "base_url"
CONF_TOKEN = "token"
CONF_NAME = "name"

# Aliases understood by `claude --model`. A pinned id such as "claude-opus-5"
# can also be typed in, because the selector allows custom values.
MODELS = ["opus", "sonnet", "haiku", "fable"]
RECOMMENDED_MODEL = "sonnet"

# Generous: a controlling turn pays several MCP round-trips inside claude.
# The add-on applies its own hard timeout, so this is only the outer bound.
DEFAULT_TIMEOUT = 90
```

Create `custom_components/claude_code_conversation/client.py`:

```python
"""HTTP client for the add-on's prompt API."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import aiohttp

from .const import DEFAULT_TIMEOUT


class PromptApiError(Exception):
    """The prompt API could not be reached or failed."""


class PromptApiAuthError(PromptApiError):
    """The prompt API rejected our token."""


class PromptApiBusyError(PromptApiError):
    """The add-on is already running its maximum number of turns."""


class PromptApiTimeoutError(PromptApiError):
    """The turn took too long."""


@dataclass(slots=True)
class ConverseResult:
    """One completed turn."""

    text: str
    session_id: str
    is_error: bool


class PromptApiClient:
    """Talks to prompt-api.js inside the add-on container."""

    def __init__(
        self, base_url: str, token: str, session: aiohttp.ClientSession
    ) -> None:
        """Store connection details."""
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._session = session

    async def async_health(self) -> dict[str, Any]:
        """Return the add-on's health payload, raising if it is not well."""
        try:
            async with self._session.get(
                f"{self._base_url}/health",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 401:
                    raise PromptApiAuthError("the add-on rejected the token")
                if resp.status != 200:
                    raise PromptApiError(f"health returned HTTP {resp.status}")
                return await resp.json()
        except TimeoutError as err:
            raise PromptApiTimeoutError("health check timed out") from err
        except aiohttp.ClientError as err:
            raise PromptApiError(f"cannot reach the add-on: {err}") from err

    async def async_converse(
        self, text: str, conversation_id: str, model: str, system_prompt: str
    ) -> ConverseResult:
        """Run one turn through `claude -p` in the add-on."""
        payload = {
            "text": text,
            "conversation_id": conversation_id,
            "model": model,
            "system_prompt": system_prompt,
        }
        try:
            async with self._session.post(
                f"{self._base_url}/conversation",
                json=payload,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
            ) as resp:
                if resp.status == 401:
                    raise PromptApiAuthError("the add-on rejected the token")
                if resp.status == 503:
                    raise PromptApiBusyError("the add-on is busy")
                if resp.status == 504:
                    raise PromptApiTimeoutError("claude took too long")
                if resp.status != 200:
                    raise PromptApiError(f"conversation returned HTTP {resp.status}")
                body = await resp.json()
        except asyncio.TimeoutError as err:
            raise PromptApiTimeoutError("the turn timed out") from err
        except aiohttp.ClientError as err:
            raise PromptApiError(f"cannot reach the add-on: {err}") from err

        return ConverseResult(
            text=body.get("text") or "",
            session_id=body.get("session_id") or "",
            is_error=bool(body.get("is_error")),
        )
```

Create `custom_components/claude_code_conversation/__init__.py`:

```python
"""The Claude Code Agent conversation integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import PromptApiAuthError, PromptApiClient, PromptApiError
from .const import CONF_BASE_URL, CONF_TOKEN

PLATFORMS = [Platform.CONVERSATION]


@dataclass(slots=True)
class ClaudeCodeData:
    """Runtime data shared by every agent on this connection."""

    client: PromptApiClient
    claude_version: str


type ClaudeCodeConfigEntry = ConfigEntry[ClaudeCodeData]


async def async_setup_entry(
    hass: HomeAssistant, entry: ClaudeCodeConfigEntry
) -> bool:
    """Set up the add-on connection."""
    client = PromptApiClient(
        entry.data[CONF_BASE_URL],
        entry.data[CONF_TOKEN],
        async_get_clientsession(hass),
    )

    try:
        health = await client.async_health()
    except PromptApiAuthError as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except PromptApiError as err:
        raise ConfigEntryNotReady(str(err)) from err

    entry.runtime_data = ClaudeCodeData(
        client=client, claude_version=health.get("claude_version", "unknown")
    )

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(
    hass: HomeAssistant, entry: ClaudeCodeConfigEntry
) -> None:
    """Reload when the user edits the entry or a subentry."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(
    hass: HomeAssistant, entry: ClaudeCodeConfigEntry
) -> bool:
    """Unload the connection."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
```

Also create an empty `custom_components/__init__.py` if the test run complains
it cannot import `custom_components.claude_code_conversation`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `.venv/bin/pytest tests/test_init.py -v`
Expected: PASS, 3 tests. The conversation platform does not exist yet, so
`async_forward_entry_setups` will log a warning about a missing platform —
that is expected and Task 9 removes it.

- [ ] **Step 6: Commit**

```bash
git add custom_components requirements_test.txt pytest.ini tests/conftest.py tests/test_init.py .gitignore
git commit -m "feat(integration): prompt API client and config entry setup"
```

---

### Task 7: Config flow for the connection

**Files:**
- Create: `custom_components/claude_code_conversation/config_flow.py`
- Create: `custom_components/claude_code_conversation/strings.json`
- Create: `custom_components/claude_code_conversation/translations/en.json`
- Create: `tests/test_config_flow.py`

**Interfaces:**
- Consumes: `PromptApiClient`, `PromptApiError`, `PromptApiAuthError` (Task 6); `CONF_BASE_URL`, `CONF_TOKEN`, `DOMAIN` (Task 6).
- Produces: `ClaudeCodeConfigFlow` with `async_step_user`, `async_step_reauth` and `async_step_reauth_confirm`, plus the module-level helper `_read_addon_discovery() -> dict[str, str]` used to pre-fill the form.

`async_setup_entry` raises `ConfigEntryAuthFailed` on a 401, which makes HA start a reauth flow. A flow handler that raises it without implementing `async_step_reauth` logs an error and strands the user, so the two ship together. This is a real scenario: the token is regenerated if `/data` is ever wiped.

- [ ] **Step 1: Write the failing test**

Create `tests/test_config_flow.py`:

```python
"""Tests for the claude_code_conversation config flow."""

from unittest.mock import patch

from aioresponses import aioresponses

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from custom_components.claude_code_conversation.const import (
    CONF_BASE_URL,
    CONF_TOKEN,
    DOMAIN,
)

HEALTH_URL = "http://addon:8098/health"
USER_INPUT = {CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"}


async def test_user_flow_creates_entry(hass: HomeAssistant) -> None:
    """A reachable add-on produces a config entry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM

    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], USER_INPUT
        )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == USER_INPUT


async def test_user_flow_reports_invalid_auth(hass: HomeAssistant) -> None:
    """A rejected token is reported as bad auth, not as a dead add-on."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )

    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=401)
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], USER_INPUT
        )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


async def test_reauth_updates_the_token(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """Reauth replaces the stored token without creating a second entry."""
    mock_config_entry.add_to_hass(hass)
    result = await mock_config_entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM

    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_TOKEN: "fresh"}
        )
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert mock_config_entry.data[CONF_TOKEN] == "fresh"


async def test_user_flow_reports_cannot_connect(hass: HomeAssistant) -> None:
    """An unreachable add-on shows an error and lets the user retry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )

    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=500)
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], USER_INPUT
        )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_prefills_from_addon_discovery(hass: HomeAssistant) -> None:
    """The form is pre-filled from the .addon.json the add-on dropped."""
    with patch(
        "custom_components.claude_code_conversation.config_flow._read_addon_discovery",
        return_value={CONF_BASE_URL: "http://discovered:8098", CONF_TOKEN: "found"},
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )

    schema = result["data_schema"].schema
    defaults = {
        str(key): key.description["suggested_value"]
        for key in schema
        if getattr(key, "description", None)
    }
    assert defaults[CONF_BASE_URL] == "http://discovered:8098"
    assert defaults[CONF_TOKEN] == "found"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest tests/test_config_flow.py -v`
Expected: FAIL — the flow handler does not exist.

- [ ] **Step 3: Write the implementation**

Create `custom_components/claude_code_conversation/config_flow.py`:

```python
"""Config flow for the Claude Code Agent conversation integration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import PromptApiAuthError, PromptApiClient, PromptApiError
from .const import CONF_BASE_URL, CONF_TOKEN, DOMAIN, LOGGER

# Written by the add-on's 30-deploy-integration.sh, beside this package. The
# add-on knows its own Supervisor hostname; an integration inside HA Core
# cannot guess it, because it is prefixed with the repository hash.
DISCOVERY_FILE = Path(__file__).parent / ".addon.json"


def _read_addon_discovery() -> dict[str, str]:
    """Return connection details the add-on left for us, or an empty dict."""
    try:
        raw = json.loads(DISCOVERY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        CONF_BASE_URL: str(raw.get("base_url", "")),
        CONF_TOKEN: str(raw.get("token", "")),
    }


class ClaudeCodeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Connect Home Assistant to the Claude Code Agent add-on."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for (or confirm) the add-on's prompt API details."""
        errors: dict[str, str] = {}

        if user_input is not None:
            client = PromptApiClient(
                user_input[CONF_BASE_URL],
                user_input[CONF_TOKEN],
                async_get_clientsession(self.hass),
            )
            try:
                await client.async_health()
            except PromptApiAuthError:
                errors["base"] = "invalid_auth"
            except PromptApiError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                LOGGER.exception("Unexpected error validating the prompt API")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(
                    title="Claude Code Agent", data=user_input
                )

        discovered = await self.hass.async_add_executor_job(_read_addon_discovery)
        suggested = {**discovered, **(user_input or {})}

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_BASE_URL,
                        description={
                            "suggested_value": suggested.get(CONF_BASE_URL, "")
                        },
                    ): str,
                    vol.Required(
                        CONF_TOKEN,
                        description={"suggested_value": suggested.get(CONF_TOKEN, "")},
                    ): str,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start reauth when the stored token stops working."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for a fresh token, pre-filled from the add-on if it left one."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}

        if user_input is not None:
            client = PromptApiClient(
                entry.data[CONF_BASE_URL],
                user_input[CONF_TOKEN],
                async_get_clientsession(self.hass),
            )
            try:
                await client.async_health()
            except PromptApiAuthError:
                errors["base"] = "invalid_auth"
            except PromptApiError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN]}
                )

        discovered = await self.hass.async_add_executor_job(_read_addon_discovery)

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_TOKEN,
                        description={
                            "suggested_value": discovered.get(CONF_TOKEN, "")
                        },
                    ): str
                }
            ),
            errors=errors,
        )
```

Extend the imports at the top of `config_flow.py` with:

```python
from collections.abc import Mapping
```

Create `custom_components/claude_code_conversation/strings.json`:

```json
{
  "config": {
    "step": {
      "user": {
        "title": "Connect to the Claude Code Agent add-on",
        "description": "These are normally filled in for you by the add-on. Change them only if you run the add-on somewhere unusual.",
        "data": {
          "base_url": "Add-on URL",
          "token": "Prompt API token"
        }
      },
      "reauth_confirm": {
        "title": "Reconnect to the Claude Code Agent add-on",
        "description": "The add-on rejected the stored token. A fresh one is filled in below if the add-on left one.",
        "data": {
          "token": "Prompt API token"
        }
      }
    },
    "error": {
      "cannot_connect": "Could not reach the add-on. Check that it is running and that the URL is correct.",
      "invalid_auth": "The add-on rejected this token. Copy it again from the add-on log.",
      "unknown": "Unexpected error."
    },
    "abort": {
      "single_instance_allowed": "The Claude Code Agent add-on is already configured.",
      "reauth_successful": "Reconnected to the add-on."
    }
  },
  "exceptions": {
    "cannot_connect": {
      "message": "Sorry, the Claude add-on isn't responding."
    },
    "busy": {
      "message": "Sorry, Claude is busy right now. Try again in a moment."
    },
    "timeout": {
      "message": "Sorry, Claude took too long to answer."
    },
    "unsupported_attachment": {
      "message": "Sorry, I can't look at images yet."
    }
  }
}
```

Copy it verbatim to `custom_components/claude_code_conversation/translations/en.json`
— HA loads user-facing text from `translations/`, while `strings.json` is the
source that HA core's translation tooling reads.

```bash
mkdir -p custom_components/claude_code_conversation/translations
cp custom_components/claude_code_conversation/strings.json \
   custom_components/claude_code_conversation/translations/en.json
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/pytest tests/test_config_flow.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add custom_components/claude_code_conversation/config_flow.py \
        custom_components/claude_code_conversation/strings.json \
        custom_components/claude_code_conversation/translations \
        tests/test_config_flow.py
git commit -m "feat(integration): config flow with add-on discovery pre-fill"
```

---

### Task 8: Conversation subentry flow

Each subentry is one Assist agent: its own model, name and system prompt.

**Files:**
- Modify: `custom_components/claude_code_conversation/config_flow.py`
- Modify: `custom_components/claude_code_conversation/const.py`
- Modify: `custom_components/claude_code_conversation/strings.json` and `translations/en.json`
- Modify: `tests/test_config_flow.py`

**Interfaces:**
- Consumes: `MODELS`, `RECOMMENDED_MODEL`, `CONF_NAME` (Task 6).
- Produces:
  - `const.py`: `RECOMMENDED_CONVERSATION_OPTIONS: dict`
  - `config_flow.py`: `ConversationSubentryFlowHandler`, registered by `ClaudeCodeConfigFlow.async_get_supported_subentry_types`.
  - Subentry `data` shape: `{"name": str, "model": str, "prompt": str, "llm_hass_api": ["assist"]}`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_config_flow.py`:

```python
async def test_conversation_subentry_creates_agent(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """Adding a conversation subentry stores model, prompt and the pinned API."""
    from homeassistant.const import CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT
    from homeassistant.helpers import llm

    from custom_components.claude_code_conversation.const import CONF_NAME

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    result = await hass.config_entries.subentries.async_init(
        (mock_config_entry.entry_id, "conversation"),
        context={"source": config_entries.SOURCE_USER},
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"],
        {CONF_NAME: "Voice", CONF_MODEL: "haiku", CONF_PROMPT: "Be brief."},
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Voice"
    assert result["data"] == {
        CONF_NAME: "Voice",
        CONF_MODEL: "haiku",
        CONF_PROMPT: "Be brief.",
        CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
    }


async def test_conversation_subentry_reconfigure(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """Reconfiguring an agent updates it in place rather than adding another."""
    from homeassistant.const import CONF_MODEL, CONF_PROMPT

    from custom_components.claude_code_conversation.const import CONF_NAME

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

        result = await hass.config_entries.subentries.async_init(
            (mock_config_entry.entry_id, "conversation"),
            context={"source": config_entries.SOURCE_USER},
        )
        await hass.config_entries.subentries.async_configure(
            result["flow_id"],
            {CONF_NAME: "Voice", CONF_MODEL: "haiku", CONF_PROMPT: "Be brief."},
        )
        await hass.async_block_till_done()

        subentry_id = next(iter(mock_config_entry.subentries))
        result = await hass.config_entries.subentries.async_init(
            (mock_config_entry.entry_id, "conversation"),
            context={
                "source": config_entries.SOURCE_RECONFIGURE,
                "subentry_id": subentry_id,
            },
        )
        result = await hass.config_entries.subentries.async_configure(
            result["flow_id"],
            {CONF_NAME: "Voice", CONF_MODEL: "opus", CONF_PROMPT: "Be brief."},
        )
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert len(mock_config_entry.subentries) == 1
    assert mock_config_entry.subentries[subentry_id].data[CONF_MODEL] == "opus"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest tests/test_config_flow.py -k subentry -v`
Expected: FAIL — the config entry supports no subentry types.

- [ ] **Step 3: Add the recommended options constant**

Append to `custom_components/claude_code_conversation/const.py`:

```python
from homeassistant.const import CONF_LLM_HASS_API, CONF_PROMPT
from homeassistant.helpers import llm

# CONF_LLM_HASS_API is pinned rather than offered as a form field. It is what
# makes chat_log.async_provide_llm_data emit the exposed-entity list into the
# system prompt, but Home Assistant never executes the tools here — Claude does,
# over MCP. A visible toggle meaning something different from the identical
# toggle in every other integration would be worse than no toggle.
RECOMMENDED_CONVERSATION_OPTIONS = {
    CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
    CONF_PROMPT: llm.DEFAULT_INSTRUCTIONS_PROMPT,
}
```

- [ ] **Step 4: Add the subentry flow handler**

In `custom_components/claude_code_conversation/config_flow.py`, extend the
imports:

```python
from homeassistant.config_entries import (
    SOURCE_USER,
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    ConfigSubentryFlow,
    SubentryFlowResult,
)
from homeassistant.const import CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TemplateSelector,
)

from .const import (
    CONF_BASE_URL,
    CONF_NAME,
    CONF_TOKEN,
    DOMAIN,
    LOGGER,
    MODELS,
    RECOMMENDED_CONVERSATION_OPTIONS,
    RECOMMENDED_MODEL,
)
```

Add this classmethod inside `ClaudeCodeConfigFlow`, directly under `VERSION = 1`:

```python
    @classmethod
    @callback
    def async_get_supported_subentry_types(
        cls, config_entry: ConfigEntry
    ) -> dict[str, type[ConfigSubentryFlow]]:
        """Each conversation agent is a subentry of the add-on connection."""
        return {"conversation": ConversationSubentryFlowHandler}
```

Append the handler at the end of the module:

```python
class ConversationSubentryFlowHandler(ConfigSubentryFlow):
    """Create or reconfigure one Claude conversation agent."""

    def __init__(self) -> None:
        """Start with no options loaded."""
        self.options: dict[str, Any] = {}

    @property
    def _is_new(self) -> bool:
        """Return True when creating rather than reconfiguring."""
        return self.source == SOURCE_USER

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Create a new agent."""
        self.options = dict(RECOMMENDED_CONVERSATION_OPTIONS)
        return await self.async_step_init(user_input)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Reconfigure an existing agent."""
        self.options = dict(self._get_reconfigure_subentry().data)
        return await self.async_step_init(user_input)

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Collect the agent's name, model and system prompt."""
        if user_input is not None:
            data = {
                **user_input,
                CONF_LLM_HASS_API: RECOMMENDED_CONVERSATION_OPTIONS[CONF_LLM_HASS_API],
            }
            if self._is_new:
                return self.async_create_entry(title=user_input[CONF_NAME], data=data)
            return self.async_update_and_abort(
                self._get_entry(),
                self._get_reconfigure_subentry(),
                title=user_input[CONF_NAME],
                data=data,
            )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_NAME,
                        description={
                            "suggested_value": self.options.get(
                                CONF_NAME, "Claude"
                            )
                        },
                    ): str,
                    vol.Required(
                        CONF_MODEL,
                        default=self.options.get(CONF_MODEL, RECOMMENDED_MODEL),
                    ): SelectSelector(
                        SelectSelectorConfig(
                            options=MODELS,
                            mode=SelectSelectorMode.DROPDOWN,
                            custom_value=True,
                        )
                    ),
                    vol.Optional(
                        CONF_PROMPT,
                        description={
                            "suggested_value": self.options.get(
                                CONF_PROMPT,
                                RECOMMENDED_CONVERSATION_OPTIONS[CONF_PROMPT],
                            )
                        },
                    ): TemplateSelector(),
                }
            ),
        )
```

- [ ] **Step 5: Add the subentry strings**

Add a `config_subentries` block to `strings.json`, as a sibling of `config`:

```json
  "config_subentries": {
    "conversation": {
      "initiate_flow": {
        "user": "Add a Claude agent",
        "reconfigure": "Reconfigure this Claude agent"
      },
      "entry_type": "Conversation agent",
      "step": {
        "init": {
          "title": "Claude conversation agent",
          "data": {
            "name": "Name",
            "model": "Model",
            "prompt": "Instructions"
          },
          "data_description": {
            "model": "Faster models answer voice commands sooner; stronger models handle complex requests better.",
            "prompt": "Instructions given to Claude at the start of every conversation."
          }
        }
      }
    }
  },
```

Re-copy to `translations/en.json`:

```bash
cp custom_components/claude_code_conversation/strings.json \
   custom_components/claude_code_conversation/translations/en.json
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_config_flow.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add custom_components/claude_code_conversation tests/test_config_flow.py
git commit -m "feat(integration): conversation subentry flow with per-agent model"
```

---

### Task 9: Conversation entity

**Files:**
- Create: `custom_components/claude_code_conversation/entity.py`
- Create: `custom_components/claude_code_conversation/conversation.py`
- Create: `tests/test_conversation.py`

**Interfaces:**
- Consumes: `ClaudeCodeConfigEntry`, `ClaudeCodeData` (Task 6); client exceptions (Task 6); subentry `data` shape (Task 8).
- Produces: `ClaudeCodeBaseEntity` in `entity.py` with `_async_handle_chat_log(chat_log)`; `ClaudeCodeConversationEntity` in `conversation.py`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_conversation.py`:

```python
"""Tests for the Claude conversation entity."""

from aioresponses import aioresponses
import pytest

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigSubentryData
from homeassistant.const import CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm

from custom_components.claude_code_conversation.const import CONF_NAME, DOMAIN

HEALTH_URL = "http://addon:8098/health"
CONVERSE_URL = "http://addon:8098/conversation"


@pytest.fixture
def agent_entry(mock_config_entry):
    """A config entry carrying one conversation agent."""
    mock_config_entry.subentries_data = [
        ConfigSubentryData(
            data={
                CONF_NAME: "Voice",
                CONF_MODEL: "haiku",
                CONF_PROMPT: "Be brief.",
                CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
            },
            subentry_type="conversation",
            title="Voice",
            unique_id=None,
        )
    ]
    return mock_config_entry


async def _setup(hass: HomeAssistant, entry, mocked) -> str:
    entry.add_to_hass(hass)
    mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return next(
        eid for eid in hass.states.async_entity_ids("conversation") if "voice" in eid
    )


async def test_agent_answers(hass: HomeAssistant, agent_entry) -> None:
    """A successful turn is spoken back to the user."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={
                "text": "The kitchen light is on.",
                "session_id": "s1",
                "duration_ms": 900,
                "cost_usd": 0.01,
                "is_error": False,
            },
        )
        result = await conversation.async_converse(
            hass, "which lights are on?", None, None, agent_id=entity_id
        )

    assert result.response.speech["plain"]["speech"] == "The kitchen light is on."


async def test_agent_sends_system_prompt_and_conversation_id(
    hass: HomeAssistant, agent_entry
) -> None:
    """HA's generated system prompt and conversation id reach the add-on."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={"text": "ok", "session_id": "s1", "is_error": False},
        )
        await conversation.async_converse(
            hass, "hello", "conv-42", None, agent_id=entity_id
        )

        request = next(iter(mocked.requests.values()))[-1]
        body = request.kwargs["json"]

    assert body["conversation_id"] == "conv-42"
    assert body["model"] == "haiku"
    assert body["text"] == "hello"
    # async_provide_llm_data injects the Assist instructions into the prompt.
    assert "Be brief." in body["system_prompt"]


async def test_agent_reports_a_busy_addon(hass: HomeAssistant, agent_entry) -> None:
    """A 503 raises a translated error rather than leaking a client exception."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(CONVERSE_URL, status=503)
        with pytest.raises(HomeAssistantError) as err:
            await conversation.async_converse(
                hass, "hello", None, None, agent_id=entity_id
            )

    assert err.value.translation_key == "busy"


async def test_agent_passes_through_claude_errors(
    hass: HomeAssistant, agent_entry
) -> None:
    """is_error results are spoken as answers, not raised as exceptions."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={
                "text": "I can't see that entity.",
                "session_id": "s1",
                "is_error": True,
            },
        )
        result = await conversation.async_converse(
            hass, "turn on the thing", None, None, agent_id=entity_id
        )

    assert result.response.speech["plain"]["speech"] == "I can't see that entity."


async def test_agent_device_reports_the_model(
    hass: HomeAssistant, agent_entry
) -> None:
    """Each agent gets its own service device labelled with its model."""
    from homeassistant.helpers import device_registry as dr

    with aioresponses() as mocked:
        await _setup(hass, agent_entry, mocked)

    subentry_id = next(iter(agent_entry.subentries))
    device = dr.async_get(hass).async_get_device(
        identifiers={(DOMAIN, subentry_id)}
    )
    assert device is not None
    assert device.model == "haiku"
    assert device.sw_version == "2.1.99"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest tests/test_conversation.py -v`
Expected: FAIL — no conversation entity is created.

- [ ] **Step 3: Write the base entity**

Create `custom_components/claude_code_conversation/entity.py`:

```python
"""Base entity for the Claude Code Agent conversation integration."""

from __future__ import annotations

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigSubentry
from homeassistant.const import CONF_MODEL
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity import Entity

from . import ClaudeCodeConfigEntry
from .client import (
    PromptApiBusyError,
    PromptApiError,
    PromptApiTimeoutError,
)
from .const import DOMAIN, LOGGER


class ClaudeCodeBaseEntity(Entity):
    """Shared behaviour for entities backed by one conversation subentry."""

    _attr_has_entity_name = True
    _attr_name = None

    def __init__(
        self, entry: ClaudeCodeConfigEntry, subentry: ConfigSubentry
    ) -> None:
        """Initialise the entity and its service device."""
        self.entry = entry
        self.subentry = subentry
        self._attr_unique_id = subentry.subentry_id
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, subentry.subentry_id)},
            name=subentry.title,
            manufacturer="Anthropic",
            model=subentry.data[CONF_MODEL],
            sw_version=entry.runtime_data.claude_version,
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    async def _async_handle_chat_log(self, chat_log: conversation.ChatLog) -> None:
        """Run one turn through the add-on and append the answer.

        Unlike the other LLM integrations there is no tool loop here: the loop
        lives inside `claude -p`, which reaches Home Assistant over MCP. One
        request in, one final answer out.
        """
        latest = chat_log.content[-1]
        if getattr(latest, "attachments", None):
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="unsupported_attachment",
            )

        system_prompt = "\n".join(
            content.content
            for content in chat_log.content
            if isinstance(content, conversation.SystemContent) and content.content
        )

        client = self.entry.runtime_data.client
        try:
            result = await client.async_converse(
                text=latest.content or "",
                conversation_id=chat_log.conversation_id,
                model=self.subentry.data[CONF_MODEL],
                system_prompt=system_prompt,
            )
        except PromptApiBusyError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="busy"
            ) from err
        except PromptApiTimeoutError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="timeout"
            ) from err
        except PromptApiError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="cannot_connect"
            ) from err

        if result.is_error:
            # Claude reporting a problem is usually a useful answer in its own
            # right ("I can't see that entity"), so speak it rather than
            # replacing it with a generic failure.
            LOGGER.debug("Claude returned an error result: %s", result.text)

        chat_log.async_add_assistant_content_without_tools(
            conversation.AssistantContent(
                agent_id=self.entity_id, content=result.text
            )
        )
```

- [ ] **Step 4: Write the conversation platform**

Create `custom_components/claude_code_conversation/conversation.py`:

```python
"""The conversation platform for the Claude Code Agent integration."""

from __future__ import annotations

from typing import Literal

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigSubentry
from homeassistant.const import CONF_LLM_HASS_API, CONF_PROMPT, MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import ClaudeCodeConfigEntry
from .const import DOMAIN
from .entity import ClaudeCodeBaseEntity


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ClaudeCodeConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create one conversation entity per conversation subentry."""
    for subentry in config_entry.subentries.values():
        if subentry.subentry_type != "conversation":
            continue
        async_add_entities(
            [ClaudeCodeConversationEntity(config_entry, subentry)],
            config_subentry_id=subentry.subentry_id,
        )


class ClaudeCodeConversationEntity(
    ClaudeCodeBaseEntity, conversation.ConversationEntity
):
    """A Claude agent selectable in an Assist pipeline."""

    _attr_supports_streaming = False

    def __init__(
        self, entry: ClaudeCodeConfigEntry, subentry: ConfigSubentry
    ) -> None:
        """Initialise the agent."""
        super().__init__(entry, subentry)
        self._attr_supported_features = (
            conversation.ConversationEntityFeature.CONTROL
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Claude handles whatever language the user speaks."""
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Answer one Assist turn."""
        options = self.subentry.data

        try:
            await chat_log.async_provide_llm_data(
                user_input.as_llm_context(DOMAIN),
                options.get(CONF_LLM_HASS_API),
                options.get(CONF_PROMPT),
                user_input.extra_system_prompt,
            )
        except conversation.ConverseError as err:
            return err.as_conversation_result()

        await self._async_handle_chat_log(chat_log)

        return conversation.async_get_result_from_chat_log(user_input, chat_log)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/ -v`
Expected: PASS, 15 tests, and the missing-platform warning from Task 6 is gone.

- [ ] **Step 6: Commit**

```bash
git add custom_components/claude_code_conversation/entity.py \
        custom_components/claude_code_conversation/conversation.py \
        tests/test_conversation.py
git commit -m "feat(integration): Claude conversation entity for Assist"
```

---

### Task 10: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md` (§11.3)

- [ ] **Step 1: Run the full suite on both sides**

```bash
cd app && npm test && cd ..
.venv/bin/pytest tests/ -v
```

Expected: 28 Node tests and 15 Python tests, all passing. Do not proceed on a
red suite.

- [ ] **Step 2: Document the feature in `README.md`**

Add a section after **First-run setup**:

````markdown
## Using Claude with Assist

The add-on also ships a Home Assistant integration that makes Claude available
as an **Assist** conversation agent, so you can talk to it from the chat panel
or a voice satellite.

```
Assist → conversation entity → add-on prompt API → claude -p → HA MCP server
```

### Setup

1. In Home Assistant, add the **Model Context Protocol Server** integration
   (Settings → Devices & Services → Add Integration). Keep the default
   **Assist** API. This is how Claude controls your devices.
2. Expose the entities you want Claude to reach under
   **Settings → Voice assistants → Expose**. Claude sees nothing else.
3. Start (or restart) this add-on. It copies the integration into your config
   directory and logs "Restart Home Assistant".
4. Restart Home Assistant.
5. Add the **Claude Code Agent** integration. The connection details are
   pre-filled — click Submit.
6. On the integration page, choose **Add Claude agent**. Give it a name, pick a
   model, and adjust the instructions if you like.
7. Point an Assist pipeline at it under **Settings → Voice assistants**.

### Choosing a model

`haiku` answers fastest and is the sensible choice for a voice satellite.
`sonnet` is the default and balances speed against capability. `opus` is worth
it for complex requests where you will wait a few seconds. You can add several
agents with different models and point different pipelines at them.

### What the Assist agent can and cannot do

The Assist agent runs with **every built-in tool disabled** — no shell, no file
access, no web. Its entire capability is the Home Assistant MCP server, scoped
to the entities you exposed to Assist. It is deliberately far more limited than
the Remote Control session, which keeps full access.

Turns are billed to your Claude subscription like any other usage, and a
controlling request costs more than a question because Claude makes several
tool calls to answer it.
````

- [ ] **Step 3: Update `CLAUDE.md`**

The project memory describes only the Telegram/Remote Control path. Add this to
§1, after the "Mental model" paragraph:

```markdown
### Second surface: Assist

The add-on also serves a Home Assistant **conversation agent** for Assist. A
custom integration (`custom_components/claude_code_conversation/`) runs inside
HA Core and POSTs each turn to a prompt API in this container, which runs
`claude -p` against Home Assistant's own MCP server. Model is configurable per
agent. Design: `docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md`.

The two surfaces share a container and credentials but nothing else: the Assist
session runs with `--tools ""` and its own MCP config, so it cannot reach a
shell or your config files.
```

- [ ] **Step 4: Build and install the add-on**

```bash
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21 -t claude-addon-test .
```

Then install the add-on on the real HA instance from the repository and start
it. In the add-on log, confirm:
- `Assist MCP config written (http://homeassistant:8123/api/mcp/assist).`
- `Deploying claude_code_conversation none -> 1.0.0`
- `[prompt-api] listening on :8098`

- [ ] **Step 5: Complete the setup and verify session continuity end to end**

Follow README steps 4-7 above, creating an agent named "Voice" on `haiku`.

Then in the Assist chat panel, ask in the **same** conversation:

1. *"which lights are on in the living room?"* — expect a real answer naming
   your entities. This proves the MCP path and the exposed-entity scope.
2. *"turn them off"* — expect the lights to turn off. This only works if
   `--resume` carried the first turn's context, so it proves the part the unit
   tests cannot.

If step 2 fails but step 1 works, the session mapping is broken: check the
add-on log for `No conversation found with session ID` and confirm
`/data/assist-workspace` exists and is writable.

- [ ] **Step 6: Record the measured latency in the spec**

Time a `haiku` turn of each kind and replace spec §11 question 3 with the
finding, for example:

```markdown
3. **Answered 2026-09-05.** A `haiku` question turn takes ~Xs, a controlling
   turn ~Ys on <hardware>. The warm pool in §9 stays rejected / is now worth
   planning.
```

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md
git commit -m "docs: document the Assist conversation agent"
```
