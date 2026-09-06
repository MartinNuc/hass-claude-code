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

// How long we'll wait for a request body to finish arriving before giving up
// on it. This endpoint is reachable only from the HA Core container over the
// Supervisor network, so the threat model for a client that never finishes
// sending is thin — but an unbounded hold (Node's own request-timeout default
// is ~300s) still isn't something to ship: a stalled or slow-drip client
// would otherwise sit on a connection for minutes. Chosen well under that
// default and generous enough for any real Assist turn's body to arrive.
const DEFAULT_BODY_TIMEOUT_MS = 20000;

function readBody(req, { limitBytes = 1024 * 1024, timeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let overLimit = false;
    let settled = false;

    function settle(isResolve, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isResolve) resolve(value); else reject(value);
    }

    const timer = setTimeout(() => {
      // The body never finished arriving — a stalled connection, or a
      // client deliberately trickling data to hold a slot open. Drop it
      // rather than wait out Node's much longer built-in default.
      req.socket.destroy();
      settle(false, Object.assign(
        new Error(`body did not finish within ${timeoutMs}ms`),
        { code: "body_timeout" },
      ));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    req.on("data", (chunk) => {
      // Once over the limit, stop accumulating but keep draining and
      // discarding: settling (and responding) before the client has
      // finished writing its body races the socket teardown against the
      // client's remaining writes and can surface as a raw connection
      // error (e.g. EPIPE) instead of the documented 400. Waiting for
      // "end" below means we only ever respond once nothing is left to
      // race against — the timeout above is what bounds how long we'll
      // wait for that "end" to come.
      if (overLimit) return;
      raw += chunk;
      if (raw.length > limitBytes) {
        overLimit = true;
        raw = ""; // no longer needed; stop holding onto it
      }
    });
    req.on("end", () => {
      if (overLimit) {
        settle(false, Object.assign(new Error("payload too large"), { code: "payload_too_large" }));
      } else {
        settle(true, raw);
      }
    });
    req.on("error", (err) => settle(false, err));
  });
}

function createApp({
  runTurn, token, claudeVersion, integrationVersion = "unknown",
  maxConcurrent = 2, bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
}) {
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
      return json(res, 200, {
        ok: true,
        claude_version: claudeVersion,
        // What this image ships. The integration compares it against its own
        // version to notice that Home Assistant has not reloaded it yet.
        integration_version: integrationVersion,
      });
    }

    let raw;
    try {
      raw = await readBody(req, { timeoutMs: bodyTimeoutMs });
    } catch (err) {
      if (err && err.code === "payload_too_large") {
        return json(res, 400, { error: "payload_too_large" });
      }
      if (err && err.code === "body_timeout") {
        // The socket is already destroyed at this point — there's no one
        // left to write a response to.
        return;
      }
      return json(res, 400, { error: "invalid_json" });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }

    const { text, conversation_id: conversationId, model, system_prompt: systemPrompt, web_access: webAccess, effort } = body;
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
        // Anything that is not exactly `true` means no web access. An older
        // integration that never sends the field, or a malformed value, must
        // fail closed rather than silently widen the tool surface.
        webAccess: webAccess === true,
        // The runner validates against its own list; a non-string here just
        // becomes "", which means "omit the flag and use claude's default".
        effort: typeof effort === "string" ? effort : "",
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

// The integration version baked into this image. The copy running inside Home
// Assistant reports its own; a mismatch means the files on disk were updated
// but Core has not reloaded them, which is invisible from the HA side and is
// exactly the confusion this is here to end.
function detectIntegrationVersion() {
  try {
    return JSON.parse(fs.readFileSync(
      "/app/custom_components/claude_code_conversation/manifest.json", "utf8"
    )).version || "unknown";
  } catch {
    return "unknown";
  }
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
  const server = createApp({
    runTurn, token,
    claudeVersion: detectClaudeVersion(),
    integrationVersion: detectIntegrationVersion(),
  });
  server.listen(PORT, () => console.log(`[prompt-api] listening on :${PORT}`));
}

if (require.main === module) main();

module.exports = { createApp };
