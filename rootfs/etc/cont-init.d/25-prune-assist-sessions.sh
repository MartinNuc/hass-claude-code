#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# Prune old Assist session transcripts.
#
# Every Home Assistant conversation gets its own Claude session, and each one
# leaves a JSONL transcript behind that nothing ever deletes. On HAOS /data is
# a finite partition, frequently on an SD card, and a voice-satellite household
# can produce thousands of these in a year. Nothing needs a transcript from two
# weeks ago: HA expires a conversation (and its conversation_id, which is what
# the session id is derived from) after about five minutes, so anything older
# than a day is already unreachable. 14 days is a generous forensic window.
#
# Deliberately not fatal and deliberately quiet about the common case: this
# runs on every container start.

# Derived from CLAUDE_CONFIG_DIR (/data/.claude) plus the Assist workspace
# (/data/assist-workspace), which Claude Code slugifies into a directory name
# by replacing "/" with "-". If ASSIST_WORKSPACE is ever changed, change this.
SESSION_DIR="/data/.claude/projects/-data-assist-workspace"
MAX_AGE_DAYS=14

# The directory does not exist until the first Assist turn has run, so a fresh
# install must not trip `set -euo pipefail` here.
if [[ ! -d "${SESSION_DIR}" ]]; then
  bashio::log.info "No Assist session directory yet; nothing to prune."
  exit 0
fi

# `find` rather than a glob: an empty or absent directory makes a glob expand
# to the literal pattern, and feeding that to rm is exactly the class of
# mistake that deletes something it should not. find matches nothing and
# outputs nothing. Scoped by -maxdepth 1, -type f and -name '*.jsonl' so it
# can only ever touch transcripts directly inside this one directory.
removed=0
while IFS= read -r session_file; do
  if rm -f -- "${session_file}"; then
    removed=$((removed + 1))
  fi
done < <(find "${SESSION_DIR}" -maxdepth 1 -type f -name '*.jsonl' -mtime "+${MAX_AGE_DAYS}" 2>/dev/null || true)

if [[ "${removed}" -gt 0 ]]; then
  bashio::log.info "Pruned ${removed} Assist session file(s) older than ${MAX_AGE_DAYS} days."
else
  bashio::log.info "No Assist session files older than ${MAX_AGE_DAYS} days."
fi
