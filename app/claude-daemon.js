"use strict";

const fs = require("node:fs");
const path = require("node:path");
// Wraps the claude process in a PTY so it detects a terminal and enters
// interactive mode (required for --remote-control to work).
// Auto-answers first-run wizards (theme selection, workspace trust).

// Shown as the session's name at claude.ai/code and in the Claude mobile app.
// Overridden by the `session_name` add-on option, which start.sh exports.
const DEFAULT_SESSION_NAME = "Home Assistant";

// Where the daemon runs, and where Claude keeps its conversation transcripts.
const WORK_DIR = "/root";
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || "/data/.claude";

// Claude names a project directory after its cwd with slashes turned into
// dashes: /root -> -root. Verified against a real run.
function projectDirFor(cwd, configDir) {
  return path.join(configDir, "projects", cwd.replace(/\//g, "-"));
}

// `claude --continue` is not a no-op when there is nothing to continue: it
// prints "No conversation found to continue" and exits 1. Passing it
// unconditionally crash-looped the daemon on every fresh install, so only ask
// to continue once a transcript exists.
function hasConversation(cwd = WORK_DIR, configDir = CONFIG_DIR) {
  try {
    return fs
      .readdirSync(projectDirFor(cwd, configDir))
      .some((entry) => entry.endsWith(".jsonl"));
  } catch {
    return false; // missing directory, or unreadable — treat as "start fresh"
  }
}

function buildArgs(env = process.env, canContinue = true) {
  // The option can be cleared in the HA UI, and a blank label would leave the
  // session unidentifiable in the Remote Control list — so fall back instead.
  const sessionName = (env.SESSION_NAME || "").trim() || DEFAULT_SESSION_NAME;

  return [
    "--permission-mode", "auto",
    "--remote-control", sessionName,
    ...(canContinue ? ["--continue"] : []),
    "--mcp-config", "/data/.claude/mcp.json",
  ];
}

// Claude's TUI renders via cursor-positioning escape codes so spaces between
// words are absent after stripping ANSI. Match collapsed (no-whitespace) text.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b./g, "");
const collapse  = (s) => s.replace(/\s+/g, "");

// Extra cleanup applied only to debug logging, never to the wizard-matching
// buffer — OSC sequences and control bytes are noise in a log but harmless to
// the plain-word patterns below, and leaving matching untouched keeps this
// change behaviour-free for the normal path.
// OSC must be removed BEFORE stripAnsi: its catch-all `\x1b.` rule would eat
// the ESC-] opener and leave the title text behind as if it were content.
const cleanForLog = (s) =>
  stripAnsi(s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, ""))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// Turns raw PTY output into readable lines, dropping blanks and consecutive
// repeats — the TUI redraws the whole screen constantly, so without the dedupe
// the log is unreadable.
function debugLinesFrom(chunk, previousLine) {
  const lines = [];
  let last = previousLine;
  for (const raw of cleanForLog(chunk).replace(/\r/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line === last) continue;
    lines.push(line);
    last = line;
  }
  return { lines, last };
}

function main() {
  const resuming = hasConversation();
  console.log(
    resuming
      ? "[daemon] Continuing the previous conversation."
      : "[daemon] No previous conversation; starting a fresh one."
  );

  // Required lazily: node-pty is a native module built inside the image, so a
  // top-level require would make this file unimportable — and the test suite
  // deliberately runs with no npm install.
  const pty = require("node-pty");

  const proc = pty.spawn("claude", buildArgs(process.env, resuming), {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd:  "/root",
    env:  { ...process.env, HOME: "/root" },
  });

  // Off by default: the TUI is redraw noise. Enabled by the
  // `debug_daemon_output` add-on option when a session will not start, since
  // suppressing this output is what makes a stuck wizard look like a healthy
  // startup in the add-on log.
  const debugOutput = Boolean(process.env.DEBUG_DAEMON_OUTPUT);
  let lastDebugLine = "";

  let buf = "";

  // Pending auto-answer: { pattern, response, handled }
  const wizards = [
    // Theme selection — option 2 (Dark mode) is pre-selected; send "2" + Enter
    { pattern: /Choosethetextstyle|Darkmode|darkmode/,   response: "2\r", handled: false },
    // Workspace trust — option 1 (Yes, I trust this folder); send "1" + Enter
    { pattern: /Itrustthisfolder|trustthisfolder|Quicksafetycheck/, response: "1\r", handled: false },
  ];

  proc.onData((data) => {
    if (debugOutput) {
      const { lines, last } = debugLinesFrom(data, lastDebugLine);
      lastDebugLine = last;
      for (const line of lines) console.log(`[claude] ${line}`);
    }

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

module.exports = { buildArgs, debugLinesFrom, hasConversation, projectDirFor, DEFAULT_SESSION_NAME };
