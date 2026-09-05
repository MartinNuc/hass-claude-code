# Claude Code Agent — Home Assistant Add-on

A Home Assistant add-on that runs a persistent [Claude Code](https://claude.ai/code) session on your HA host. You interact with it from Telegram; it configures Home Assistant on your behalf using the official HA MCP server. No custom agent code — just Claude Code with its first-party Telegram Channels feature and the HA MCP server wired together.

```
Your phone (Telegram) → Claude Code Channels → claude process (on HA host) → HA MCP → Home Assistant
```

---

## What this add-on does

- Runs `claude --remote-control --channels plugin:telegram@claude-plugins-official` as a supervised daemon inside a Docker container on your HA host.
- Connects Claude to Home Assistant via [hass-mcp](https://github.com/voicepilot/hass-mcp), automatically authenticated with the Supervisor token (no extra setup on HAOS).
- Persists the Claude session and credentials across restarts so conversations resume after a reboot.
- Lets you ask Claude things like "turn off all lights in the living room", "create an automation that dims the bedroom at sunset", or "show me what automations changed last week".

---

## Requirements

| Requirement | Notes |
|---|---|
| Home Assistant OS or Supervised | A plain Container/Core install cannot run add-ons |
| Claude Max or Pro subscription | The add-on authenticates via `claude login` (OAuth). An API key is not used. |
| Telegram bot token | Create a bot with [@BotFather](https://t.me/BotFather) and copy the token |
| Claude Code v2.1.80 or newer | Enforced at image build time; the Dockerfile will fail if the installer provides an older version |

---

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Click the three-dot menu in the top-right and choose **Repositories**.
3. Add the repository URL:
   ```
   https://github.com/MartinNuc/hass-claude-code
   ```
4. Find **Claude Code Agent** in the store and click **Install**.

---

## Configuration

| Option | Required | Default | Description |
|---|---|---|---|
| `telegram_bot_token` | Yes | — | Token from [@BotFather](https://t.me/BotFather). The Telegram channel will not connect without this. |
| `ha_agent_key` | Yes | — | API key from the [HA Vibecode Agent](https://github.com/Coolver/home-assistant-mcp) add-on Web UI. |
| `ha_agent_url` | No | `http://homeassistant:8099` | URL of the HA Vibecode Agent. The default works on HAOS. Change only if you run the agent on a non-standard port or host. |

Set both `telegram_bot_token` and `ha_agent_key` before starting the add-on for the first time.

---

## First-run setup

The Telegram plugin must be installed once via Claude's Remote Control interface before Telegram messages will work. This is a one-time step.

### Step 1 — Authenticate with Claude

Start the add-on. If no credentials exist, the init script runs `claude auth login` automatically and prints an authentication URL to the add-on log.

1. Open **Settings → Add-ons → Claude Code Agent → Log**.
2. Find the line that contains a `https://claude.ai/...` URL.
3. Open that URL in a browser and complete the sign-in.
4. The add-on log will confirm "Login complete." and the daemon will start.

Credentials are saved to the persistent add-on volume (`/data/.claude/.credentials.json`) and survive restarts.

### Step 2 — Connect via Remote Control

1. Go to [claude.ai/code](https://claude.ai/code) in a browser (same account you just logged into).
2. Look for the **Remote Control** panel. Your add-on session should appear with a green dot indicating it is connected.

If no session appears, confirm the add-on is running and check the log for errors.

### Step 3 — Install the Telegram plugin

In the Remote Control chat interface, run these two commands:

```
/plugin install telegram@claude-plugins-official
```

Wait for confirmation, then:

```
/reload-plugins
```

After the plugin installs, **restart the add-on** (Settings → Add-ons → Claude Code Agent → Restart). The daemon will now start with the Telegram channel active.

### Step 4 — Pair your Telegram account

1. Open Telegram and send any message to your bot (the one whose token you configured).
2. The bot will reply with a pairing code.
3. In the Remote Control interface, run:
   ```
   /telegram:access pair <code>
   ```
   Replace `<code>` with the code from your bot.
4. Lock the bot to your account only:
   ```
   /telegram:access policy allowlist
   ```

Your Telegram account is now the only one that can send messages to the agent. Test it by sending a message like "what time is it?" to your bot.

---

## Using Claude with Assist

The add-on also ships a Home Assistant integration that makes Claude available
as an **Assist** conversation agent, so you can talk to it from the chat panel
or a voice satellite.

```
Assist → conversation entity → add-on prompt API → claude -p → HA MCP server
```

### Setup

1. In Home Assistant, add the **Model Context Protocol Server** integration
   (Settings → Devices & Services → Add Integration). Keep the default
   **Assist** API. This is how Claude controls your devices.
2. Expose the entities you want Claude to reach under
   **Settings → Voice assistants → Expose**. Claude sees nothing else.
3. Start (or restart) this add-on. It copies the integration into your config
   directory and logs a warning asking you to restart Home Assistant.
4. Restart Home Assistant.
5. Add the **Claude Code Agent** integration. The connection details are
   pre-filled — click Submit.
6. On the integration page, choose **Add a Claude agent**. Give it a name, pick
   a model, and adjust the instructions if you like.
7. Point an Assist pipeline at it under **Settings → Voice assistants**.

### Choosing a model

`haiku` answers fastest and is the sensible choice for a voice satellite.
`sonnet` is the default and balances speed against capability. `opus` is worth
it for complex requests where you will wait a few seconds. `fable` is also
offered. The model field accepts a custom value too, so you can type a pinned
model id such as `claude-opus-5` instead of an alias — check the spelling, an
id Claude Code does not recognise fails the turn. You can add several agents
with different models and point different pipelines at them.

### What the Assist agent can and cannot do

The Assist agent runs with **every built-in tool disabled** — no shell, no file
access, no web. Its entire capability is the Home Assistant MCP server, scoped
to the entities you exposed to Assist. It is deliberately far more limited than
the Remote Control session, which keeps full access.

Turns are billed to your Claude subscription like any other usage, and a
controlling request costs more than a question because Claude makes several
tool calls to answer it.

---

## Security

**Secrets** — No secret (API key, bot token, OAuth token, HA access token) is baked into the Docker image or committed to the repository. All credentials are injected at runtime via add-on options or the persistent volume.

**Telegram allow-list** — After completing Step 4 above, the bot only accepts messages from your Telegram account. All other senders are silently ignored by the Channels plugin.

**Container isolation** — Claude runs inside a Docker container managed by the HA Supervisor. It cannot reach host system paths outside its mapped volumes.

**HA token scope** — On HAOS the add-on uses the auto-injected Supervisor token, which is scoped to what the add-on declares in its manifest. If you supply your own `ha_token`, scope it to the minimum you need.

**Git-backed HA config** — The add-on mounts your HA config directory read-write. Before making significant changes, ask Claude to commit a checkpoint so you can roll back with `git revert`.

**`--dangerously-skip-permissions`** — This flag is always on. It is intentional: the container boundary replaces the interactive permission prompts that are impractical in a headless daemon. The safety model is container isolation + scoped HA token + git rollback, not prompt-by-prompt approval. If you are not comfortable with this, do not install the add-on.

---

## Cost

This add-on uses your Claude Max or Pro subscription. Token usage accumulates whenever the session is active and processing messages. The session stays warm (running) continuously, which means background keepalive activity also consumes quota.

Monitor your usage at [claude.ai](https://claude.ai). If you notice high consumption, stop the add-on when not in use.

---

## Troubleshooting

**Add-on stops at startup with "No Claude credentials found" and no URL appears**

The `claude login` call failed before it could print a URL. Check that:
- The container has outbound internet access.
- The add-on log is scrolled to the top of the current startup — the URL may have appeared in a previous boot.

Try restarting the add-on; it will attempt `claude login` again.

---

**Telegram bot does not respond**

- Confirm `telegram_bot_token` is set in the add-on configuration.
- Confirm you completed Steps 3 and 4 (plugin install + restart + pairing).
- Check the add-on log for lines mentioning "telegram" — common messages include "channel could not register" (plugin not installed) or "unauthorized sender" (pairing not done).
- Verify the bot token is correct by sending a test request: `https://api.telegram.org/bot<YOUR_TOKEN>/getMe`

---

**Remote Control session does not appear at claude.ai/code**

- Confirm the add-on is running (not stopped or in a restart loop).
- Check the log for `remote-control` errors.
- Make sure you are signed into the same Claude account used during `claude login`.
- The Remote Control feature requires Claude Code v2.1.80+; the build enforces this but a stale cached image might bypass the check. Rebuild the image.

---

**HA MCP not connecting / Claude cannot see HA entities**

- On HAOS the default URL (`http://supervisor/core`) should work automatically. If you changed `ha_url`, verify the URL is reachable from inside the container.
- Check that `homeassistant_api: true` is present in the add-on manifest (it is, by default) — this is what causes the Supervisor to inject the token.
- If you supplied a custom `ha_token`, verify it is a valid long-lived token in HA (Profile → Security → Long-Lived Access Tokens).
