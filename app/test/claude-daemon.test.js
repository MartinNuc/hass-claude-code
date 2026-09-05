"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildArgs, DEFAULT_SESSION_NAME } = require("../claude-daemon.js");

const nameIn = (args) => args[args.indexOf("--remote-control") + 1];

test("falls back to the default session name when SESSION_NAME is unset", () => {
  assert.equal(nameIn(buildArgs({})), DEFAULT_SESSION_NAME);
});

test("uses SESSION_NAME when it is set", () => {
  assert.equal(nameIn(buildArgs({ SESSION_NAME: "Attic Pi" })), "Attic Pi");
});

test("falls back when SESSION_NAME is blank or whitespace only", () => {
  // The add-on option can be cleared in the HA UI. Handing --remote-control an
  // empty label would leave the session unidentifiable at claude.ai/code.
  for (const value of ["", "   ", "\t"]) {
    assert.equal(nameIn(buildArgs({ SESSION_NAME: value })), DEFAULT_SESSION_NAME);
  }
});

test("trims surrounding whitespace from the session name", () => {
  assert.equal(nameIn(buildArgs({ SESSION_NAME: "  Attic Pi  " })), "Attic Pi");
});

test("leaves the rest of the daemon argv untouched", () => {
  assert.deepEqual(buildArgs({ SESSION_NAME: "Attic Pi" }), [
    "--permission-mode", "auto",
    "--remote-control", "Attic Pi",
    "--continue",
    "--mcp-config", "/data/.claude/mcp.json",
  ]);
});

// ── debug output ────────────────────────────────────────────────────────────
// This exists because a stuck first-run wizard once looked like a healthy
// startup: the daemon swallowed the PTY output that said what it was waiting on.

const { debugLinesFrom } = require("../claude-daemon.js");

test("debug output strips ANSI and yields readable lines", () => {
  const { lines } = debugLinesFrom("\x1b[32mChoose the text style\x1b[0m\r\nDark mode", "");
  assert.deepEqual(lines, ["Choose the text style", "Dark mode"]);
});

test("debug output drops blank lines", () => {
  const { lines } = debugLinesFrom("one\r\n\r\n   \r\ntwo", "");
  assert.deepEqual(lines, ["one", "two"]);
});

test("debug output drops consecutive repeats from TUI redraws", () => {
  const { lines } = debugLinesFrom("same\nsame\nsame\nother", "");
  assert.deepEqual(lines, ["same", "other"]);
});

test("debug output keeps a repeat that is not consecutive", () => {
  const { lines } = debugLinesFrom("a\nb\na", "");
  assert.deepEqual(lines, ["a", "b", "a"]);
});

test("debug output carries dedupe state across chunks", () => {
  const first = debugLinesFrom("prompt", "");
  const second = debugLinesFrom("prompt", first.last);
  assert.deepEqual(second.lines, []);
});

test("debug output removes OSC sequences and control bytes", () => {
  const { lines } = debugLinesFrom("\x1b]0;window title\x07Welcome\x00 to Claude", "");
  assert.deepEqual(lines, ["Welcome to Claude"]);
});
