"use strict";
// Spawns `claude -p` for one Assist turn and normalises the result.
//
// The Assist session is deliberately narrow: --tools "" removes every built-in
// tool, so by default the whole capability surface is Home Assistant's own
// intents. There is no deny-list to keep in sync as Claude Code grows new
// tools — an empty allow-list is closed by construction.
//
// Two capabilities can be added on top, both off unless asked for:
//   * web access, per agent, via WEB_TOOLS below;
//   * MCP servers the user registered with `claude mcp add --scope user`,
//     which are picked up because --strict-mcp-config is deliberately NOT
//     passed (that flag is exactly what excludes settings-configured servers).
//
// Everything here runs unattended: an Assist turn has no human to answer a
// permission prompt, and it is invocable by anyone who can speak to a voice
// satellite. That is why the code-running tools stay out permanently.

const { spawn } = require("child_process");
const { sessionIdFor, SessionTracker } = require("./session-map.js");

// Hardcoded, never assembled from caller input: a bug or a bad request upstream
// must not be able to turn "web access" into Bash. Adding a code-running tool
// here would mean running it unattended at the request of anyone who can talk
// to a voice satellite — see the header.
const WEB_TOOLS = "WebSearch,WebFetch";

const RESUME_MISSING_RE = /No conversation found with session ID/i;
const SESSION_IN_USE_RE = /Session ID .* is already in use/i;

function isResultEnvelope(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.type === "result";
}

// The text to speak back. `result` is not always a usable string: on a budget
// stop claude reports subtype "error_max_budget_usd" with `result: null`, and
// answering an Assist turn with silence tells the user nothing. Synthesise a
// short line carrying the subtype so they get something they can act on.
function resultText(envelope) {
  if (typeof envelope.result === "string" && envelope.result.trim()) {
    return envelope.result;
  }
  if (envelope.is_error) {
    return `Claude stopped: ${envelope.subtype || "unknown error"}`;
  }
  return "";
}

class ClaudeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaudeError";
    this.code = code; // "timeout" | "resume_missing" | "session_in_use" | "failed"
  }
}

function buildArgs({ text, sessionId, model, systemPrompt, resume, mcpConfig, maxBudgetUsd, webAccess = false }) {
  return [
    "-p", text,
    "--output-format", "json",
    "--model", model,
    resume ? "--resume" : "--session-id", sessionId,
    "--system-prompt", systemPrompt,
    // Record the prompt once per conversation and reuse it on resume: cheaper,
    // and keeps every turn of one conversation on identical instructions.
    //
    // Real consequence, per `claude --help`: an existing snapshot record is
    // reused *verbatim* on resume. Home Assistant regenerates the system
    // prompt every turn — it carries "Current time is ..." and the current
    // exposed-entity list — but from turn 2 onward claude keeps turn 1's copy.
    // Bounded by HA's ~5 minute conversation TTL (a new conversation_id means
    // a new session and a fresh snapshot), so a stale clock or a just-exposed
    // entity self-corrects within minutes. Acceptable, but not obvious.
    "--system-prompt-snapshot", "on",
    "--mcp-config", mcpConfig,
    // NOT --strict-mcp-config. That flag excludes MCP servers configured
    // through settings, and leaving it off is what lets a user register extra
    // servers from the add-on's web terminal with `claude mcp add --scope
    // user` and have the Assist agent see them next to Home Assistant's own.
    // The trade is real and documented in CLAUDE.md §7: any server added that
    // way is reachable by voice, unattended.
    "--tools", webAccess ? WEB_TOOLS : "",
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
        env: {
          ...process.env,
          HOME: "/root",
          // Claude Code refuses --permission-mode bypassPermissions when it is
          // running as root: "cannot be used with root/sudo privileges for
          // security reasons", the same guard that blocks
          // --dangerously-skip-permissions. The add-on container is uid 0 and
          // that is not ours to change, so without this every Assist turn dies
          // before it starts. Observed on claude 2.1.261; older builds did not
          // apply the guard to bypassPermissions, which is why this surfaced
          // as a sudden regression rather than at first run.
          //
          // Declaring the sandbox is accurate here, not a way around the
          // check. buildArgs spawns this process with --tools "" and
          // --strict-mcp-config: no shell, no file access, no web, nothing but
          // HA's own intent tools. The capability the guard exists to protect
          // is already absent. The Remote Control session, which does have a
          // shell, runs --permission-mode auto in a different process and
          // never sees this variable.
          IS_SANDBOX: "1",
          ...extraEnv(),
        },
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

        let envelope = null;
        let parsed = false;
        try {
          envelope = JSON.parse(stdout);
          parsed = true;
        } catch { /* not JSON — handled per exit code below */ }

        if (code === 0) {
          if (parsed) return resolve(envelope);
          return reject(new ClaudeError("failed", `unparseable claude output: ${stdout.slice(0, 200)}`));
        }

        // Non-zero exit. Session recovery is decided from stderr *first*: those
        // two conditions are retryable with the opposite session flag, and a
        // result envelope on stdout must not mask them.
        if (RESUME_MISSING_RE.test(stderr)) {
          return reject(new ClaudeError("resume_missing", stderr.trim()));
        }
        if (SESSION_IN_USE_RE.test(stderr)) {
          return reject(new ClaudeError("session_in_use", stderr.trim()));
        }

        // Otherwise a well-formed result envelope on stdout is the most
        // informative thing we have, and claude emits one on several non-zero
        // exits: budget exhaustion (exit 1, *empty stderr*, subtype
        // "error_max_budget_usd") and an unrecognized --model (exit 1, valid
        // envelope, a one-line stderr diagnostic). Rejecting those turned an
        // answerable failure into a 502 -> "the add-on isn't responding",
        // which is both wrong and unactionable — the add-on is fine.
        if (parsed && isResultEnvelope(envelope)) return resolve(envelope);

        return reject(new ClaudeError("failed", stderr.trim() || `claude exited ${code}`));
      });
    });
  }

  async function runTurn({ text, conversationId, model, systemPrompt, webAccess = false }) {
    const sessionId = sessionIdFor(conversationId);
    const base = { text, sessionId, model, systemPrompt, mcpConfig, maxBudgetUsd, webAccess };
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
      text: resultText(envelope),
      sessionId: envelope.session_id || sessionId,
      durationMs: envelope.duration_ms ?? null,
      costUsd: envelope.total_cost_usd ?? null,
      isError: Boolean(envelope.is_error),
    };
  }

  return { runTurn };
}

module.exports = { buildArgs, createRunner, ClaudeError };
