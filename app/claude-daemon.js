"use strict";
// Wraps the claude process in a PTY so it detects a terminal and enters
// interactive mode (required for --remote-control and --channels to work).
// Also auto-answers the first-run theme wizard.

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

// Claude's TUI renders via cursor-positioning escape codes, so spaces between
// words are absent after stripping ANSI. Match collapsed (no-whitespace) text.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b./g, "");
const collapse  = (s) => s.replace(/\s+/g, "");

let wizardHandled = false;
let buf = "";

proc.onData((data) => {
  process.stdout.write(data);

  if (wizardHandled) return;

  buf += collapse(stripAnsi(data));
  if (buf.length > 3000) buf = buf.slice(-1500);

  // "Choose the text style" wizard — option 2 (Dark mode) is pre-selected.
  // Send "2" + Enter to confirm it explicitly.
  if (buf.includes("Choosethetextstyle") || buf.includes("Darkmode") || buf.includes("darkmode")) {
    setTimeout(() => {
      if (!wizardHandled) {
        proc.write("2\r");
        wizardHandled = true;
      }
    }, 600);
  }

  // Once we see the syntax theme line the wizard is complete.
  if (buf.includes("Syntaxtheme") || buf.includes("syntaxtheme")) {
    wizardHandled = true;
    buf = "";
  }
});

proc.onExit(({ exitCode }) => process.exit(exitCode ?? 1));
