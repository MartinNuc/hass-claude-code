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
