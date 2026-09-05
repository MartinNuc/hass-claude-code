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
    let overLimit = false;

    req.on("data", (chunk) => {
      // Once over the limit, stop accumulating but keep draining and
      // discarding: settling (and responding) before the client has
      // finished writing its body races the socket teardown against the
      // client's remaining writes and can surface as a raw connection
      // error (e.g. EPIPE) instead of the documented 400. Waiting for
      // "end" below means we only ever respond once nothing is left to
      // race against.
      if (overLimit) return;
      raw += chunk;
      if (raw.length > limitBytes) {
        overLimit = true;
        raw = ""; // no longer needed; stop holding onto it
      }
    });
    req.on("end", () => {
      if (overLimit) {
        reject(Object.assign(new Error("payload too large"), { code: "payload_too_large" }));
      } else {
        resolve(raw);
      }
    });
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

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err && err.code === "payload_too_large") {
        return json(res, 400, { error: "payload_too_large" });
      }
      return json(res, 400, { error: "invalid_json" });
    }

    let body;
    try {
      body = JSON.parse(raw);
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
