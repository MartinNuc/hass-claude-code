"use strict";
// Wraps the claude process in a PTY so it detects a terminal and enters
// interactive mode (required for --remote-control and --channels to work).
// Also auto-answers the first-run theme wizard if settings.json wasn't pre-seeded.

const pty = require("node-pty");

const proc = pty.spawn("claude", [
  "--permission-mode", "auto",
  "--remote-control",
  "--channels", "plugin:telegram@claude-plugins-official",
  "--mcp-config", "/data/.claude/mcp.json",
], {
  name: "xterm-256color",
  cols: 220,
  rows: 50,
  cwd:  "/root",
  env:  { ...process.env, HOME: "/root" },
});

// Strip ANSI escape codes for reliable text matching
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b./g, "");

let wizardHandled = false;
let buf = "";

proc.onData((data) => {
  process.stdout.write(data);

  if (wizardHandled) return;

  buf += stripAnsi(data);
  if (buf.length > 2000) buf = buf.slice(-1000); // keep buffer bounded

  if (buf.includes("Choose the text style")) {
    // First-run wizard: option 2 (Dark mode) is pre-selected — press Enter to confirm
    setTimeout(() => { proc.write("\r"); wizardHandled = true; }, 400);
  } else if (buf.includes("Syntax theme")) {
    // Wizard already completed (or skipped via settings.json)
    wizardHandled = true;
    buf = "";
  }
});

proc.onExit(({ exitCode }) => process.exit(exitCode ?? 1));
