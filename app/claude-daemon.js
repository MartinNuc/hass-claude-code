"use strict";
// Wraps the claude process in a PTY so it detects a terminal and enters
// interactive mode (required for --remote-control and --channels to work).
// Without a PTY, claude falls back to print mode and errors on missing input.

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

proc.onData((data) => process.stdout.write(data));

proc.onExit(({ exitCode }) => process.exit(exitCode ?? 1));
