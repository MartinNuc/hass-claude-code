# CLAUDE.md — Home Assistant Add-on: "Claude Channels Agent"

This file orients any Claude Code session working in this repo. It is both the
project memory and the build specification. Read it fully before editing.

---

## 1. What we are building

A **Home Assistant add-on** that runs a long-lived Claude Code session in the
background on the HA host, driven over **Telegram via Claude Code Channels**
(first-party, research-preview feature). The session has the **Home Assistant
MCP** connected so the user can configure HA conversationally from their phone.

This is *not* a custom agent loop. We deliberately reuse:
- **Claude Code Channels** for the Telegram bridge (no bot glue code of our own).
- The **HA MCP server** the user already uses, connected via Claude Code's MCP config.
- A **supervisor** (s6 inside the add-on, or `Restart=always`) to keep the
  `claude --channels ...` process alive across crashes and host reboots, with
  session `--resume` for continuity.

### Mental model
Telegram → Claude Code Channels MCP → long-running `claude` process (on HA host)
→ HA MCP → Home Assistant. The messaging layer only carries the conversation;
all files/tools/state stay on the host.

### Second surface: Assist

The add-on also serves a Home Assistant **conversation agent** for Assist. A
custom integration (`custom_components/claude_code_conversation/`) runs inside
HA Core and POSTs each turn to a prompt API in this container, which runs
`claude -p` against Home Assistant's own MCP server. Model is configurable per
agent. Design: `docs/superpowers/specs/2026-09-05-claude-assist-conversation-design.md`.

The two surfaces share a container and credentials but nothing else: the Assist
session runs with `--tools ""` and its own MCP config, so it cannot reach a
shell or your config files.

---

## 2. ASSUMPTIONS — confirm or correct before building

These were not finalized. Each is flagged inline where it affects code. If any
is wrong, fix it here first and the rest of the spec follows.

- **[ASSUMPTION: install_type = HA OS]** — Packaged as a true add-on (Docker
  image under Supervisor). If install is **Container/Core**, a real add-on is
  impossible: ship the same image as a plain `docker run`/compose sidecar and
  ignore the `config.yaml`/Supervisor sections.
- **[ASSUMPTION: auth = Anthropic API key]** — Credential injected as an add-on
  secret/env var. If using a **Pro/Max subscription login**, the OAuth token
  must be mounted from a persistent volume (interactive `claude login` cannot
  run unattended inside the container — see §7).
- **[ASSUMPTION]** Single trusted user; the user accepts running the agent with
  reduced prompting in exchange for hands-off operation (see §6 on permissions).

---

## 3. Hard requirements & non-negotiables

1. **Channels needs Claude Code v2.1.80+.** Pin and verify at build and at start.
2. Must launch with the `--channels` flag — installing the plugin is not enough.
3. **Never bake secrets into the image.** API key / bot token / OAuth token come
   from add-on options or mounted volumes at runtime only.
4. **HA config must be under git.** Every change Claude makes is committable and
   revertible. The add-on must not be the only copy of state.
5. **Persist the Claude session + config across restarts** via a mounted volume
   so `--resume` works after a reboot.
6. Lock the Telegram bot to the user's own chat/user ID (allow-list).

---

## 4. Repository layout (target)

```
ha-claude-addon/
  CLAUDE.md                # this file
  README.md                # human-facing setup/usage
  config.yaml              # HA add-on manifest  [HA OS / Supervised only]
  Dockerfile               # builds the add-on image
  rootfs/
    etc/services.d/claude/ # s6 service: run + finish scripts (supervision)
    etc/cont-init.d/        # one-time init: validate version, restore session
  app/
    start.sh               # entrypoint: assemble flags, exec claude --channels
    settings/
      .claude/settings.json # tool scoping / permission policy (see §6)
      .mcp.json             # HA MCP server definition (see §5)
  docker-compose.yml       # [Container/Core fallback path only]
```

---

## 5. Home Assistant MCP connection

- Reuse the user's existing HA MCP server config. Define it in `app/settings/.mcp.json`
  and point Claude Code at it on launch.
- HA MCP auth uses a **long-lived access token**, injected as a runtime secret —
  never committed. Scope the token to the minimum the user is comfortable with.
- On the **HA OS** path the add-on can reach core via the internal Supervisor
  network (`http://supervisor/core` / `homeassistant:8123`); on the
  **Container** path use the host-reachable HA URL. Flag which is in use.

---

## 6. Permissions & autonomy — the central design tension

Remote/unattended operation structurally pushes toward bypassing prompts: if
Claude hits a permission prompt while the user is away, the session pauses until
approved locally. Two supported modes — make this a single add-on option
`autonomy_mode`:

- **`gated` (default, recommended):** Run with a scoped `.claude/settings.json`
  that **allow-lists safe tools** (HA reads, safe service calls, file reads,
  git status/diff/commit) and **denies or requires confirmation** for
  destructive ones (config overwrite, HA restart, `rm`, arbitrary bash).
  Confirmations surface back through the Telegram channel.
- **`auto`:** `--dangerously-skip-permissions`. Only valid because the add-on is
  containerized, the HA token is scoped, and git enables rollback. Document the
  blast radius loudly in README.

Defense-in-depth regardless of mode: container isolation, scoped HA token,
git-backed config, restricted `PATH`, allow-listed Telegram user.

---

## 7. Authentication wiring

- **[API key path]** `ANTHROPIC_API_KEY` from add-on options → env at runtime.
  Cleanest for unattended use; no interactive step.
- **[Subscription path]** `claude login` is interactive and cannot run headless
  in the container. Procedure: run login once on a machine with a browser, then
  mount the resulting credential/OAuth token into the add-on's persistent volume
  at the path Claude Code expects. `start.sh` must detect a missing/expired
  token and fail loudly with instructions rather than hang.
- Telegram bot token: from BotFather, stored as an add-on secret.

---

## 8. Supervision & lifecycle

- Keep one `claude --channels ...` process resident. On exit/crash, restart with
  exponential backoff and `--resume <session_id>` to preserve context.
- Capture and persist `session_id` (from the session file / first run) to the
  mounted volume so reboots resume the same conversation.
- Add a health check: detect a hung/STUCK session (no progress, channel
  unresponsive) and restart. A simple watchdog loop is enough; the TeleClaw
  project is a reference for the DEAD/STUCK + dual-watchdog pattern if more
  robustness is wanted later — do not copy wholesale, start minimal.
- On HA OS, also set the add-on to restart on host reboot.

---

## 9. Cost & rate limits

Long-running async sessions consume Claude Code token quota continuously when
active. Document expected burn; advise the user to watch plan rate limits.
Consider an idle-timeout option that lets the session lapse after N minutes of
inactivity and cold-resumes on the next Telegram message (trades warm latency
for cost). Keep it OFF by default; the user explicitly wants a warm session.

---

## 10. Security checklist (enforce in review)

- [ ] No secret in the image or git history (scan before first commit).
- [ ] Telegram user/chat-ID allow-list active; reject all others.
- [ ] HA token scoped; documented what it can and cannot do.
- [ ] `autonomy_mode` default is `gated`; `auto` requires explicit opt-in.
- [ ] HA config repo is git-backed with a known-good baseline commit.
- [ ] CAPTCHA/2FA/login flows are never automated by the agent.
- [ ] Container cannot write outside its intended config/volume paths.

---

## 11. Build & test order (suggested)

1. Minimal image: Node + pinned Claude Code, prints version, exits. Verify ≥2.1.80.
2. Wire API key (or mount OAuth token); confirm `claude -p "hello"` works in-container.
3. Add `.mcp.json`; confirm HA MCP connects and a **read-only** HA query works.
4. Add Channels plugin + `--channels`; confirm Telegram round-trip with a read-only ask.
5. Add `.claude/settings.json` gating; confirm a write attempt prompts via Telegram.
6. Add supervision + session persistence; kill the process and a reboot, confirm resume.
7. Only then test a real `gated` config edit end-to-end, with git diff review.
8. (Optional) flip to `auto` mode behind explicit opt-in and re-run §10 checklist.

---

## 12. Out of scope (for now)

- Multi-user / multi-session management.
- Voice / sub-second interaction loops.
- Any custom agent loop or bot framework (Channels replaces this).
- Exposing ports to the public internet (Telegram is the only ingress).

---

## Notes for the working Claude session
- Prefer small, reviewable commits; never leave HA config in a broken state.
- When unsure whether an action is destructive, treat it as destructive.
- Surface assumptions in §2 to the user before relying on them.
