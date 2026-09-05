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
