# CLAUDE.md — Home Assistant Add-on: "Claude Code Agent"

This file orients any Claude Code session working in this repo. It is both the
project memory and the build specification. Read it fully before editing.

---

## 1. What we are building

A **Home Assistant add-on** that puts Claude Code on the HA host and exposes it
through two surfaces:

- **Remote Control** — one long-lived `claude` process, driven from
  claude.ai/code or the Claude mobile app. Full tool surface: shell, files, and
  whatever MCP servers are configured. This is the "configure my house
  conversationally" session.
- **Assist** — a Home Assistant conversation agent. A custom integration inside
  HA Core POSTs each turn to a small HTTP API in this container, which runs one
  `claude -p` against Home Assistant's own MCP server and exits.

This is *not* a custom agent loop. We deliberately reuse:
- **Claude Code Remote Control** for the interactive surface (no bot glue of our own).
- **MCP servers** for everything that touches Home Assistant.
- **s6-overlay** (already in the HA base image) to supervise the processes and
  restart them on crash, with `--continue` for session continuity.

### Mental model

```
claude.ai/code ──▶ claude (PTY, --remote-control) ──MCP──▶ Vibecode Agent add-on ──▶ HA
Assist pipeline ─▶ prompt-api :8098 ─▶ claude -p ──MCP──▶ HA's own /api/mcp/assist
```

The messaging layer only carries the conversation; all files, tools and state
stay on the host.

The two surfaces share a container and one set of Claude credentials and
**nothing else**. Separate MCP configs, separate tool policy, separate
processes. The Assist session runs with `--tools ""`, so by default it reaches
nothing but HA's intent tools; web access and user-registered MCP servers are
opt-in (§7). It can never reach a shell or your config files. Do not
"simplify" this by merging the two configs.

Design notes for the Assist surface:
`docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md`.
In-container debugging guide: `docs/ASSIST_DEBUGGING.md` — this is baked into
the image as `/root/CLAUDE.md`, so the Remote Control session auto-loads it. If
you change how the Assist surface works, change that file too.

---

## 2. Settled decisions

These were open questions once. They are decided; treat them as constraints,
and if one has to change, change it here first.

- **install_type = HA OS / Supervised.** Packaged as a true add-on (Docker
  image under Supervisor). Container/Core installs cannot run add-ons and are
  not supported.
- **auth = Max/Pro subscription (OAuth).** There is no API-key path. Login is
  interactive and happens once through the add-on's web terminal (see §8).
- **Single trusted user.** No multi-tenancy, no per-user policy. The Remote
  Control session is as privileged as the person holding the Claude account.

---

## 3. Hard requirements & non-negotiables

1. **Remote Control needs Claude Code v2.1.80+.** The Dockerfile verifies the
   installed version at build time and fails the build below that.
2. **Never bake secrets into the image.** OAuth token, HA tokens and the
   Vibecode agent key come from add-on options or the persistent volume at
   runtime only.
3. **HA config should be under git.** Every change Claude makes is committable
   and revertible. The add-on must not be the only copy of state.
4. **Persist Claude's config and credentials across restarts.**
   `CLAUDE_CONFIG_DIR=/data/.claude` lives on the add-on volume so `--continue`
   works after a reboot.
5. **A `cont-init.d` script that exits non-zero halts the whole container.**
   Init must degrade, not die: a missing option gets a loud warning and a valid
   fallback file, never a hard exit. `10-setup.sh` and `20-mcp-assist.sh` are
   both written this way and say so in comments.
6. **The two surfaces must not share tool surface.** See §5 and §7.

---

## 4. Repository layout

```
hass-claude-code/
  CLAUDE.md                  # this file
  README.md                  # human-facing setup/usage
  CHANGELOG.md               # shown in HA's update dialog — see §14
  config.yaml                # HA add-on manifest (options, ingress, maps)
  build.yaml                 # base images + OCI labels
  repository.yaml            # add-on repository metadata
  Dockerfile                 # builds the add-on image
  rootfs/etc/
    cont-init.d/
      10-setup.sh            # settings + Remote Control MCP config
      20-mcp-assist.sh       # Assist MCP config + endpoint probe
      25-prune-assist-sessions.sh  # delete transcripts older than 14 days
      30-deploy-integration.sh     # copy integration into HA config, write .addon.json
    services.d/
      claude/                # long-lived Remote Control session (execs app/start.sh)
      ttyd/                  # web terminal on :7681, ingress (app/server.js)
      prompt-api/            # Assist HTTP API on :8098 (app/prompt-api.js)
  app/
    start.sh                 # credential gate, then exec claude-daemon.js
    claude-daemon.js         # spawns claude in a PTY, answers first-run wizards
    prompt-api.js            # HTTP front door for the Assist agent
    server.js                # web terminal (xterm.js + node-pty over WebSocket)
    lib/claude-runner.js     # builds and runs `claude -p` for one Assist turn
    lib/session-map.js       # HA conversation_id → stable Claude session UUID
    test/                    # node:test suites
  custom_components/claude_code_conversation/   # the HA integration
  tests/                     # pytest suites for the integration
  docs/ASSIST_DEBUGGING.md   # baked into the image as /root/CLAUDE.md
  docs/superpowers/          # historical plans and specs — do not edit
```

---

## 5. MCP wiring — two configs, deliberately

**Remote Control** — `/data/.claude/mcp.json`, written by `10-setup.sh`:
`@coolver/home-assistant-mcp` launched via `npx`, pointed at the separate
[**HA Vibecode Agent**](https://github.com/Coolver/home-assistant-vibecode-agent) add-on with `HA_AGENT_URL` (default `http://homeassistant:8099`)
and `HA_AGENT_KEY`. If `ha_agent_key` is blank the script warns loudly and
writes `{"mcpServers":{}}` — `claude-daemon.js` passes `--mcp-config`
unconditionally and must never be pointed at a file that does not exist.

**Assist** — `/data/.claude/mcp-assist.json`, written by `20-mcp-assist.sh`:
an HTTP MCP server at `http://supervisor/core/api/mcp/assist`, authenticated
with `SUPERVISOR_TOKEN`. This is the Supervisor's Core API proxy, and it is the
default because reaching Core directly does not work: on a real HAOS install
`homeassistant` resolves to the Supervisor network gateway and 8123 is refused
outright, and the port is not 8123 on every install anyway.

This file is passed with `--mcp-config` but *without* `--strict-mcp-config`, so
servers the user registers with `claude mcp add --scope user` load alongside it
(§7). There is no override and no user configuration on this path — a
`ha_mcp_token`/`ha_url` pair existed briefly and was removed: its only observed
use was a user pointing it at the Vibecode Agent (port 8099), which 404s and
cost them the agent's tools while the working default sat unused. Do not
reintroduce it speculatively. The same script probes the endpoint
once at start and reports the result in the log, because the failure mode is
otherwise silent: no MCP server means the agent chats happily and controls
nothing.

Both files carry credentials and are created with `install -m 600 /dev/null`
*before* any content is written, so there is no window at a umask-derived mode.
Same for `/data/prompt-api-token` and the deployed `.addon.json`.

---

## 6. Add-on options

The complete set (`config.yaml`). Adding an option means touching `options:`,
`schema:`, the init script that reads it, and the README table.

| Option | Schema | Used by | Effect when blank |
|---|---|---|---|
| `ha_agent_url` | `str?` | `10-setup.sh` | falls back to `http://homeassistant:8099` |
| `ha_agent_key` | `str?` | `10-setup.sh` | warn; Remote Control session gets no MCP servers |
| `debug_daemon_output` | `bool?` | `app/start.sh` | off; PTY output stays out of the log |
| `session_name` | `str?` | `app/start.sh` | falls back to `Home Assistant` |

Four options total, and only `ha_agent_key` normally needs a value. Keep it
that way: every option is a thing a user can get wrong.

Nothing else is configurable by the user. Tunables for the Assist path
(`ASSIST_TIMEOUT_MS`, `ASSIST_MAX_BUDGET_USD`, `ASSIST_WORKSPACE`,
`ASSIST_MCP_CONFIG`, `PROMPT_API_PORT`) are environment variables read by
`lib/claude-runner.js` and `prompt-api.js`, intended for debugging.

---

## 7. Permissions & autonomy

Unattended operation pushes toward bypassing prompts: if Claude hits a
permission prompt while the user is away, the session pauses. The two surfaces
resolve that tension differently, and that asymmetry is the whole design.

- **Remote Control** runs `--permission-mode auto` — not
  `--dangerously-skip-permissions`. Claude judges each action for itself and
  raises a prompt only when it decides one is warranted; the user answers those
  in the Remote Control interface, which is reachable from a phone. This surface
  has a shell and read-write access to `/homeassistant`. Container isolation and
  git-backed config are the real boundary, not the prompt.
- **Assist** runs `--permission-mode bypassPermissions`. Its default capability
  is exactly HA's intent tools over Assist-exposed entities: `--tools ""`
  removes every built-in tool, `--setting-sources ""` ignores on-disk settings
  and `--disable-slash-commands` closes the last escape hatch. There is no
  deny-list to keep in sync as Claude Code grows new tools — an empty
  allow-list is closed by construction.

  Two capabilities can be added on top, both off unless asked for:

  - **Web tools**, per agent, from the conversation subentry's `web_access`
    flag. The runner substitutes the hardcoded `WEB_TOOLS` constant; the list
    is never assembled from caller input, so no request can turn this into
    `Bash`. A missing key on an older subentry reads as False.
  - **User MCP servers**, registered with `claude mcp add --scope user` in the
    web terminal. These load because `--strict-mcp-config` is deliberately NOT
    passed — per `claude --help`, that flag is precisely what excludes
    settings-configured servers.

  The governing fact, and the reason code-running tools stay out permanently:
  **an Assist turn runs unattended.** There is no screen to show a permission
  prompt on, and the trigger is anyone who can speak to a voice satellite.
  Entity names and attributes come from devices rather than from the user, so
  they are an injection surface too. Under those conditions a shell would be
  remote code execution by speech. Web access and a server the user chose are a
  considered trade; `Bash` is not, and must not be added behind a flag "for
  symmetry".

  `claude-runner.js` also spawns each turn with `IS_SANDBOX=1`. This is not
  optional and not a loosening: from claude 2.1.261, `bypassPermissions` is
  refused outright under root ("cannot be used with root/sudo privileges"),
  and the add-on container is uid 0, so every Assist turn failed before
  reaching Home Assistant. The declaration is accurate because the
  allow-list above never contains a code-running tool, so the capability the
  guard protects is absent whatever the user enabled. It
  is set on the Assist child process only — never on the Remote Control
  session, which has a real shell and runs `--permission-mode auto`. If a
  code-running tool is ever admitted to the Assist argv, this must go with it.

A per-turn `--max-budget-usd` caps the cost of a runaway Assist turn.

---

## 8. Authentication wiring

There is one path: the user's Claude Max/Pro subscription.

- `claude auth login` is interactive and cannot run headless. The add-on serves
  a web terminal (`app/server.js`, port 7681, exposed via HA ingress) purely so
  the user can run it once. See README §First-run setup.
- The result lands in `/data/.claude/.credentials.json` on the persistent
  volume and survives restarts.
- Both `app/start.sh` and `services.d/prompt-api/run` gate on that file: if it
  is missing they log an instruction, `sleep 60` and `exit 1`, so s6 retries
  them until the user has logged in. Fail loudly and retry — never hang.
- No `ANTHROPIC_API_KEY` path exists. Do not add one without revisiting §2.

---

## 9. Supervision & lifecycle

- `cont-init.d` runs once at container start, in numeric order: settings and
  Remote Control MCP config, Assist MCP config and probe, transcript pruning,
  integration deployment.
- Three s6 services then run in parallel: `claude`, `ttyd`, `prompt-api`. Each
  has a `finish` script that logs the exit code; s6 restarts them.
- The Remote Control session is spawned through `node-pty` so `claude` sees a
  TTY and enters interactive mode. `claude-daemon.js` also auto-answers the
  first-run wizards (theme, workspace trust) by pattern-matching the collapsed,
  ANSI-stripped TUI output, and suppresses that output from the log because it
  is cursor-positioning noise.
- Continuity comes from `--continue`, which resumes the most recent conversation
  in the working directory. There is no session-id bookkeeping for this surface.
- Assist continuity is different: `session-map.js` derives a stable UUIDv5 from
  the HA `conversation_id`, so turn one uses `--session-id` and later turns
  `--resume`, with a one-shot retry the other way if the in-memory tracker is
  wrong. `25-prune-assist-sessions.sh` deletes transcripts older than 14 days.
- On HA OS, `boot: auto` in the manifest restarts the add-on after a host reboot.

---

## 10. Cost & rate limits

A long-running session consumes Claude Code token quota whenever it is active.
Document expected burn; advise the user to watch plan rate limits. Assist turns
bill on top of that, bounded per turn by `--max-budget-usd`.

An idle-timeout option that lets the Remote Control session lapse after N
minutes and cold-resumes on the next message would trade warm latency for cost.
Not implemented, and it would stay OFF by default: the user explicitly wants a
warm session.

---

## 11. Security checklist (enforce in review)

- [ ] No secret in the image or git history.
- [ ] Files holding a token are created at mode 600 *before* content is written.
- [ ] HA tokens scoped; documented what they can and cannot do.
- [ ] The Assist tool list is only ever `""` or the hardcoded `WEB_TOOLS`; no
      code-running tool reaches it, whatever the caller sends.
- [ ] `--strict-mcp-config` stays off the Assist argv (user MCP servers depend
      on it) and the two surfaces still keep separate `--mcp-config` files.
- [ ] HA config repo is git-backed with a known-good baseline commit.
- [ ] CAPTCHA/2FA/login flows are never automated by the agent.
- [ ] Container cannot write outside its intended config/volume paths.
- [ ] No new add-on option is added without updating schema, init script and README.

---

## 12. Tests

```
cd app && npm test        # node:test — prompt API, claude runner, session map
.venv/bin/pytest tests/ -q  # the claude_code_conversation integration
```

`app/test/fixtures/fake-claude` stands in for the real binary so the runner
tests never spend tokens. Both suites run without a container.

---

## 13. Releasing

Home Assistant decides an update is available by comparing the installed
version against `version:` in `config.yaml` — not against a git tag. A merge
to `main` without a version bump ships nothing.

Every user-visible change therefore does three things together:

1. Bump `version:` in `config.yaml`. Semver against user-visible behaviour:
   patch for a fix, minor for a feature, major for a break.
2. Add a section at the TOP of `CHANGELOG.md`, headed `## <version>`. HA
   renders this file in the update dialog, so a missing entry shows the user
   "No changelog found" — the reason this file exists.
3. Tag the merge commit `v<version>`.

The changelog is read by someone deciding whether to click Update, on a phone,
who does not know the internals. So: what changed for them and whether it
needs action from them — not which file moved. A breaking change leads with
what to do BEFORE updating, because Supervisor validates saved options against
the schema and a leftover value for a removed key stops the add-on from
starting. That is the failure mode this project actually shipped, in 1.8.0.

Commit messages are for the repository and stay technical; changelog entries
are for users and do not. Do not paste one into the other.

---

## 14. Out of scope (for now)

- Multi-user / multi-session management.
- Any custom agent loop or bot framework.
- Exposing ports to the public internet — the only ingress is HA's own, for the
  web terminal.
- An API-key authentication path.

---

## Notes for the working Claude session
- Prefer small, reviewable commits; never leave HA config in a broken state.
- When unsure whether an action is destructive, treat it as destructive.
- `docs/superpowers/**` records what was true when written. Do not update it.
