"use strict";
// Wraps the claude process in a PTY so it detects a terminal and enters
// interactive mode (required for --remote-control to work).
// Auto-answers first-run wizards (theme selection, workspace trust).

// Shown as the session's name at claude.ai/code and in the Claude mobile app.
// Overridden by the `session_name` add-on option, which start.sh exports.
const DEFAULT_SESSION_NAME = "Home Assistant";

function buildArgs(env = process.env) {
  // The option can be cleared in the HA UI, and a blank label would leave the
  // session unidentifiable in the Remote Control list — so fall back instead.
  const sessionName = (env.SESSION_NAME || "").trim() || DEFAULT_SESSION_NAME;

  return [
    "--permission-mode", "auto",
    "--remote-control", sessionName,
    "--continue",
    "--mcp-config", "/data/.claude/mcp.json",
  ];
}

function main() {
  // Required lazily: node-pty is a native module built inside the image, so a
  // top-level require would make this file unimportable — and the test suite
  // deliberately runs with no npm install.
  const pty = require("node-pty");

  const proc = pty.spawn("claude", buildArgs(), {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd:  "/root",
    env:  { ...process.env, HOME: "/root" },
  });

  // Claude's TUI renders via cursor-positioning escape codes so spaces between
  // words are absent after stripping ANSI. Match collapsed (no-whitespace) text.
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b./g, "");
  const collapse  = (s) => s.replace(/\s+/g, "");

  let buf = "";

  // Pending auto-answer: { pattern, response, handled }
  const wizards = [
    // Theme selection — option 2 (Dark mode) is pre-selected; send "2" + Enter
    { pattern: /Choosethetextstyle|Darkmode|darkmode/,   response: "2\r", handled: false },
    // Workspace trust — option 1 (Yes, I trust this folder); send "1" + Enter
    { pattern: /Itrustthisfolder|trustthisfolder|Quicksafetycheck/, response: "1\r", handled: false },
  ];

  proc.onData((data) => {
    // PTY output is Claude's interactive TUI — escape codes and cursor movements
    // that are meaningless in plain text logs. Suppress it entirely.
    // The session is controlled via Remote Control (claude.ai/code).

    buf += collapse(stripAnsi(data));
    if (buf.length > 4000) buf = buf.slice(-2000);

    for (const w of wizards) {
      if (!w.handled && w.pattern.test(buf)) {
        w.handled = true;
        setTimeout(() => proc.write(w.response), 600);
      }
    }
  });

  proc.onExit(({ exitCode }) => process.exit(exitCode ?? 1));
}

if (require.main === module) main();

module.exports = { buildArgs, DEFAULT_SESSION_NAME };
