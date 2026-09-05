# Debugging the Claude Assist agent — orientation for a session inside this add-on

You are Claude Code running **inside the Claude Code Agent add-on container** on
a Home Assistant host. This file is auto-loaded because it is `CLAUDE.md` in
your working directory. It exists to make you useful at diagnosing the **Assist
conversation agent**, which is a separate surface from the session you are in.

**You do not have the git repository here.** The Supervisor clones it onto the
host, not into this container. You have `/app` (shipped in the image), `/data`
(persistent add-on volume) and `/homeassistant` (the user's HA config, mounted
read-write). If you need to see the source of something, read it under `/app`.

---

## 1. What the Assist agent is

Two surfaces share this container and the same Claude credentials, and nothing
else:

| | Your session (Remote Control) | The Assist agent |
|---|---|---|
| Started by | `/etc/services.d/claude/run` | `/etc/services.d/prompt-api/run` |
| Process | one long-lived `claude` | one `claude -p` per turn, then exits |
| MCP config | `/data/.claude/mcp.json` | `/data/.claude/mcp-assist.json` |
| Tools | full (shell, files, web) | **`--tools ""`** — none |
| Reached by | claude.ai/code | HA's Assist pipeline over HTTP |

If the add-on's `ha_agent_key` option is empty, `/data/.claude/mcp.json` is
written as `{"mcpServers":{}}` and your own session starts with no MCP servers
— `10-setup.sh` logs a warning saying so. That is deliberate: the Assist agent
must not be blocked by a missing key for an unrelated add-on. It does not
affect the Assist agent, which has its own config.

The request path is a loop that leaves Home Assistant and comes back:

```
Assist pipeline                                       [HA Core container]
  conversation.<agent>
        │  POST /conversation  (bearer token, Supervisor network)
        ▼
  prompt-api :8098                                    [this container]
        │  spawn: claude -p --output-format json …
        ▼
  claude ──MCP(http)──▶ http://homeassistant:8123/api/mcp/assist
                                                      [back into HA Core]
```

Home Assistant builds the system prompt (including the list of entities exposed
to Assist) and sends it along. Claude then does its own tool-calling over MCP.
The integration makes **one** HTTP request per turn and has no tool loop — if
you go looking for one in `entity.py`, its absence is deliberate, not a bug.

## 2. Where everything lives in this container

| Path | What it is |
|---|---|
| `/app/prompt-api.js` | the HTTP server (`/health`, `/conversation`) |
| `/app/lib/claude-runner.js` | builds the `claude -p` argv, spawns it, timeout + session recovery |
| `/app/lib/session-map.js` | HA `conversation_id` → stable Claude session UUID |
| `/app/custom_components/claude_code_conversation/` | the integration **as shipped in the image** |
| `/homeassistant/custom_components/claude_code_conversation/` | the integration **as deployed to HA** |
| `/data/prompt-api-token` | bearer token, generated on first run, mode 600 |
| `/data/.claude/mcp-assist.json` | Assist-only MCP config, mode 600 |
| `/data/assist-workspace` | cwd for every `claude -p` turn |
| `/data/.claude/projects/-data-assist-workspace/` | **the session transcripts** (`*.jsonl`), one per HA conversation |
| `/etc/cont-init.d/20-mcp-assist.sh` | writes the MCP config, then probes the HA MCP endpoint |
| `/etc/cont-init.d/25-prune-assist-sessions.sh` | deletes session transcripts older than 14 days |
| `/etc/cont-init.d/30-deploy-integration.sh` | deploys the integration, writes `.addon.json` |

## 3. Diagnose in this order

Work down the chain. Each step assumes the ones above it passed.

**1 — Is the prompt API running?**

```bash
curl -sS -H "Authorization: Bearer $(cat /data/prompt-api-token)" \
  http://localhost:8098/health
```

Expect `{"ok":true,"claude_version":"…"}`. A connection error means the service
is not up: check `ls /run/service` for the service directory name, then
`s6-svstat /run/service/prompt-api`. The service refuses to start and retries
every 60s while `/data/.claude/.credentials.json` is missing — that is the
same auth gate the Remote Control session uses, so if you are reading this in a
working session, credentials exist.

A `401` here means the token you read does not match the one the server loaded.
The server reads the token **once at startup**, so if `/data/prompt-api-token`
was regenerated afterwards, restart the add-on.

A 401 on a real Assist turn makes the integration start Home Assistant's reauth
flow, so the user sees a "Reconfigure"/"Repair" prompt in the HA UI with a
fresh token pre-filled from `.addon.json`. If they are seeing that, the stored
token is stale (typically `/data` was wiped and `30-deploy-integration.sh`
generated a new one) — accepting the prompt is the fix.

**2 — Can `claude -p` reach Home Assistant's MCP server?**

This is the single most likely thing to be broken. Check the add-on log first:
`20-mcp-assist.sh` probes the endpoint once at container start and logs either

```
HA MCP server reachable (HTTP 200) — the Assist agent has tools.
```

or a loud multi-line error naming the two likely causes. That probe is not
fatal on purpose — the add-on starts either way — so an error there means the
agent is up and chatting with no ability to control anything. See §5.

```bash
# IS_SANDBOX=1 is required, not optional: this container runs as root and
# claude refuses --permission-mode bypassPermissions under root without it
# ("cannot be used with root/sudo privileges"). prompt-api sets it for every
# real turn; omit it here and this probe fails for a reason that has nothing
# to do with MCP, sending you down the wrong path.
IS_SANDBOX=1 claude -p "List the tools you have available. Do not call any of them." \
  --output-format json --model haiku \
  --mcp-config /data/.claude/mcp-assist.json --strict-mcp-config \
  --tools "" --permission-mode bypassPermissions --setting-sources ""
```

Expect `"is_error": false` and a `result` naming HA intent tools such as
`HassTurnOn` or `GetLiveContext`. If it says it has no tools, the MCP
connection failed — go to §5.

**3 — Does a full turn work?**

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $(cat /data/prompt-api-token)" \
  -H "Content-Type: application/json" \
  -d '{"text":"Which lights are on?","conversation_id":"debug-1","model":"haiku","system_prompt":"Answer briefly."}' \
  http://localhost:8098/conversation
```

Expect `{"text":"…","session_id":"…","is_error":false,…}`. Re-run it with the
**same** `conversation_id` and a follow-up like `"Turn them off."` — if the
second turn has no memory of the first, session continuity is broken (§4).

**4 — Is the HA side wired up?**

The add-on cannot see this; ask the user to confirm in the HA UI:
- the **Model Context Protocol Server** integration is installed, on the Assist API
- entities are exposed under **Settings → Voice assistants → Expose** (an agent with nothing exposed will politely tell you it cannot see any devices)
- the **Claude Code Agent** integration is added and has at least one agent subentry
- an Assist pipeline actually points at that agent

## 4. What the status codes and failures mean

`/conversation` returns:

| Code | Meaning | Where to look |
|---|---|---|
| `200` + `is_error:false` | success | — |
| `200` + `is_error:true` | Claude answered but reported a problem; the text is spoken to the user as-is | usually a real answer ("I can't see that entity") |
| `400` | malformed body, or body over 1 MB | the caller |
| `401` | wrong bearer token | §3 step 1 |
| `503` | already running 2 turns; load shed on purpose | concurrent voice commands |
| `504` | `claude` exceeded 60 s and its process group was killed | slow model, or an MCP call hanging |
| `502` | anything else — the JSON `detail` field carries the real error | add-on log |

**A non-zero `claude` exit is not automatically a 502.** The runner parses
stdout regardless of exit code, because the real binary exits 1 while still
printing a complete result envelope for at least two cases a user can reach:
budget exhaustion (`subtype: "error_max_budget_usd"`, empty stderr, and
`result: null`) and an unrecognized `--model` id, which is reachable because
the model field accepts custom values. Those come back as `200` with
`is_error: true`. When `result` is not a usable string the runner synthesises
`Claude stopped: <subtype>` so the user hears something actionable instead of
silence. Only the two session-recovery conditions (checked on stderr first) and
a non-zero exit with no usable envelope still fail the request.

**Session continuity.** `session-map.js` hashes the HA `conversation_id` into a
UUIDv5. Turn one runs `--session-id <uuid>`, later turns `--resume <uuid>`. An
in-memory tracker remembers which sessions exist, with a 1-hour TTL and a
200-entry cap. That tracker is only a fast path: if it is wrong in either
direction the runner retries once with the other flag, recovering from both an
add-on restart (forgot a live session) and a wiped `/data` (remembers a dead
one). `/data/assist-workspace` is only the cwd; the transcripts themselves live
under `/data/.claude/projects/-data-assist-workspace/`. If either is missing or
unwritable, every turn silently starts fresh.

**Timeouts.** 60 s hard limit, killing the whole process group so a hung MCP
subprocess cannot be orphaned. Tune with `ASSIST_TIMEOUT_MS` if you must, but a
turn taking that long usually means an MCP call is stuck, not that the limit is
too tight.

**Cost guard.** Each turn runs with `--max-budget-usd 0.50`. Hitting it is the
`error_max_budget_usd` case above.

**Frozen system prompt.** Turns run with `--system-prompt-snapshot on`, and an
existing snapshot record is reused verbatim on resume. Home Assistant rebuilds
the system prompt every turn — it carries `Current time is …` and the current
exposed-entity list — but from turn 2 onward `claude` keeps turn 1's copy. HA
expires a conversation after roughly five minutes, so this self-corrects
quickly; it is still the explanation if a long conversation insists the time is
wrong or cannot see an entity that was exposed mid-conversation.

**Session pruning.** `25-prune-assist-sessions.sh` deletes `*.jsonl`
transcripts older than 14 days from
`/data/.claude/projects/-data-assist-workspace/` at every container start, and
logs how many it removed. Without it these accumulate forever on a finite
(often SD-card) `/data` partition. Nothing needs a transcript that old: the HA
`conversation_id` the session id is derived from expires in minutes.

## 5. The HA MCP endpoint and its token

`20-mcp-assist.sh` points the Assist agent at
`http://supervisor/core/api/mcp/assist` — the Supervisor's Core API proxy —
and authenticates with `SUPERVISOR_TOKEN`. Both are confirmed working on real
HAOS hardware (HTTP 200). There is no configuration on this path and no
override option; talking to Core directly was tried and removed, because
`homeassistant` resolves to the Supervisor network gateway and refuses 8123,
and the one time the override was used in practice it was pointed at the
Vibecode Agent add-on and 404ed.

If the probe reports 401 the Supervisor token was rejected, which would be new
— and a code change, not a settings change. Confirm with the raw curl below
before concluding that, since a 404 (missing MCP integration) is far more
likely and reads similarly at a glance.

Verify the raw endpoint directly before concluding anything:

```bash
curl -isS -X POST \
  -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}' \
  http://homeassistant:8123/api/mcp/assist | head -40
```

If that 401s, try `http://supervisor/core/api/mcp/assist` with the same header
before reaching for a long-lived token.

## 6. Traps

**Editing the deployed integration is temporary.** Changes under
`/homeassistant/custom_components/claude_code_conversation/` are wiped by
`30-deploy-integration.sh` whenever the shipped `manifest.json` version differs
from the deployed one — it does `rm -rf` then `cp -r`. Edit there only to test a
hypothesis, and tell the user the real fix belongs in the repository.

**`.addon.json` holds a live credential.** It sits beside the deployed
integration in the shared HA config directory, mode 600. Do not cat it into a
log, a message, or anything the user might paste somewhere public. Same for
`/data/prompt-api-token` and `/data/.claude/mcp-assist.json`.

**The Assist agent is deliberately powerless.** `--tools ""` plus
`--strict-mcp-config` means its entire capability is HA's own intent tools,
scoped to Assist-exposed entities. If someone asks you to give it shell or file
access "to make debugging easier", that removes the whole security model — say
no and debug from this session instead, where you already have those tools.

**Restarting HA is disruptive.** The user may be mid-conversation or relying on
automations. Ask before suggesting it, and say why it is needed.

## 7. Reporting back

When you find something, say which layer it broke at — HA side, the HTTP hop,
`claude -p` itself, or the MCP hop back into HA. The four have completely
different fixes, and "Assist isn't working" is what the user already knows.
