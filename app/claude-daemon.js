"use strict";
// Wraps the claude process in a PTY so it detects a terminal and enters
// interactive mode (required for --remote-control and --channels to work).
// Auto-answers first-run wizards (theme selection, workspace trust).

const pty = require("node-pty");

const proc = pty.spawn("claude", [
  "--permission-mode", "auto",
  "--remote-control", "Home Assistant",
  "--channels", "plugin:telegram@claude-plugins-official",
  "--mcp-config", "/data/.claude/mcp.json",
], {
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
  // Strip ANSI escape codes and non-printable chars before logging.
  // Claude's TUI renders via terminal control sequences which look like
  // garbage in plain text add-on logs.
  const clean = data
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")  // CSI sequences
    .replace(/\x1b./g, "")                      // other escape sequences
    .replace(/[^\x20-\x7E\n\r\t]/g, "");        // non-printable / non-ASCII

  // Only log lines that have meaningful printable content
  const lines = clean.split(/\r?\n/).filter(l => l.trim().length > 2);
  if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");

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
