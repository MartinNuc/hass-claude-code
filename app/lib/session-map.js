"use strict";
// Maps a Home Assistant conversation_id (a ULID) onto a stable Claude session
// UUID, so turn 2 of a conversation can --resume turn 1.

const crypto = require("crypto");

// Any fixed v4 UUID works as the namespace. It only has to stay constant
// across restarts so the same conversation_id always yields the same session.
const NAMESPACE = "6f1d5b2c-9a3e-4f18-8c71-2b4a0d6e5c93";

function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto
    .createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return [
    h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20),
  ].join("-");
}

function sessionIdFor(conversationId) {
  return uuidv5(String(conversationId), NAMESPACE);
}

// Remembers which session ids have been started. Purely a fast path: if this
// is wrong (add-on restarted, /data wiped) claude-runner recovers by retrying
// with the other flag. Bounded so a long-lived process cannot grow forever.
class SessionTracker {
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 200, now = Date.now } = {}) {
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._now = now;
    this._seen = new Map(); // sessionId -> lastSeenMs
  }

  isKnown(sessionId) {
    const seenAt = this._seen.get(sessionId);
    if (seenAt === undefined) return false;
    if (this._now() - seenAt > this._ttlMs) {
      this._seen.delete(sessionId);
      return false;
    }
    return true;
  }

  mark(sessionId) {
    this._seen.delete(sessionId); // re-insert so Map order is oldest-first
    this._seen.set(sessionId, this._now());
    while (this._seen.size > this._maxEntries) {
      const oldest = this._seen.keys().next().value;
      this._seen.delete(oldest);
    }
  }

  forget(sessionId) {
    this._seen.delete(sessionId);
  }
}

module.exports = { sessionIdFor, SessionTracker };
