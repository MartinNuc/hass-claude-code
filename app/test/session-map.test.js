"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sessionIdFor, SessionTracker } = require("../lib/session-map.js");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("sessionIdFor is deterministic", () => {
  assert.equal(sessionIdFor("01JABCD"), sessionIdFor("01JABCD"));
});

test("sessionIdFor produces a valid v5 UUID", () => {
  assert.match(sessionIdFor("01JABCD"), UUID_RE);
});

test("sessionIdFor separates different conversations", () => {
  assert.notEqual(sessionIdFor("01JABCD"), sessionIdFor("01JABCE"));
});

test("tracker reports unknown sessions as unknown", () => {
  const t = new SessionTracker();
  assert.equal(t.isKnown("abc"), false);
});

test("tracker remembers a marked session", () => {
  const t = new SessionTracker();
  t.mark("abc");
  assert.equal(t.isKnown("abc"), true);
});

test("tracker forgets a session on demand", () => {
  const t = new SessionTracker();
  t.mark("abc");
  t.forget("abc");
  assert.equal(t.isKnown("abc"), false);
});

test("tracker expires entries past the ttl", () => {
  let clock = 1000;
  const t = new SessionTracker({ ttlMs: 500, now: () => clock });
  t.mark("abc");
  clock = 1400;
  assert.equal(t.isKnown("abc"), true);
  clock = 1600;
  assert.equal(t.isKnown("abc"), false);
});

test("tracker evicts the oldest entry past maxEntries", () => {
  let clock = 0;
  const t = new SessionTracker({ maxEntries: 2, now: () => clock++ });
  t.mark("a");
  t.mark("b");
  t.mark("c");
  assert.equal(t.isKnown("a"), false);
  assert.equal(t.isKnown("c"), true);
});
