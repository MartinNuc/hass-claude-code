# Claude Code Agent — Home Assistant Add-on

A Home Assistant add-on that runs a persistent [Claude Code](https://claude.ai/code) session on your HA host. You drive it from claude.ai/code or the Claude mobile app through Claude Code's Remote Control feature, and it configures Home Assistant on your behalf over MCP. No custom agent code — just Claude Code and an MCP server wired together.

```
claude.ai/code or Claude mobile app → Remote Control → claude process (on HA host) → MCP → Home Assistant
```

The add-on also exposes Claude as an **Assist conversation agent**, so you can talk to it from the HA chat panel or a voice satellite. That is a separate, deliberately much more limited surface — see [Using Claude with Assist](#using-claude-with-assist).

---

## What this add-on does

- Runs `claude --permission-mode auto --remote-control "Home Assistant" --continue` as a supervised daemon inside a Docker container on your HA host.
- Connects that session to Home Assistant via the [`@coolver/home-assistant-mcp`](https://github.com/Coolver/home-assistant-mcp) MCP server, which talks to the separate **HA Vibecode Agent** add-on using the `ha_agent_key` you configure. This part is optional; without a key the session simply starts with no HA tools.
- Serves a second, sandboxed Claude session as an Assist conversation agent, scoped to the entities you expose to Assist.
- Persists the Claude session and credentials on the add-on's own volume, so `--continue` picks the conversation back up after a restart or reboot.
- Lets you ask Claude things like "turn off all lights in the living room", "create an automation that dims the bedroom at sunset", or "show me what automations changed last week".

---

## Requirements

| Requirement | Notes |
|---|---|
| Home Assistant OS or Supervised | A plain Container/Core install cannot run add-ons |
| Claude Max or Pro subscription | The add-on authenticates via `claude auth login` (OAuth). An API key is not used. |
| Claude Code v2.1.80 or newer | Enforced at image build time; the Dockerfile will fail if the installer provides an older version |
| HA Vibecode Agent add-on | Optional. Provides the MCP server the Remote Control session uses to reach Home Assistant. |

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
| `session_name` | No | `Home Assistant` | The name this instance shows in the Remote Control list at [claude.ai/code](https://claude.ai/code) and in the Claude mobile app. Change it if you run Claude Code on more than one machine. |
| `ha_agent_key` | No | — | API key from the [HA Vibecode Agent](https://github.com/Coolver/home-assistant-mcp) add-on Web UI. Leave blank if you do not run that add-on. |
| `ha_agent_url` | No | `http://homeassistant:8099` | URL of the HA Vibecode Agent. The default works on HAOS. Change only if you run the agent on a non-standard port or host. |
| `ha_mcp_token` | No | — | Long-lived HA access token for Home Assistant's **own** MCP server, used by the Assist agent. Only needed if HA rejects the Supervisor token — see [Security](#security). |

Leaving `ha_agent_key` blank is supported and does not stop the add-on. The init script logs a warning and writes an empty MCP config, so the **Remote Control session starts with no MCP tools** — Claude can still use its shell and file access, but it has no direct HA entity or service tools. The **Assist agent is unaffected**: it uses its own MCP config pointing at Home Assistant's built-in MCP server.

---

## First-run setup

### Step 1 — Authenticate with Claude

Claude Code needs a one-time interactive login. The add-on ships a web terminal for exactly this.

1. Start the add-on. The log will show a banner saying Claude is not authenticated yet and that it will retry every 60 seconds.
2. Open **Settings → Add-ons → Claude Code Agent → Web UI**. You get a shell inside the container.
3. Run:
   ```
   claude auth login
   ```
4. Follow the browser flow it prints and complete the sign-in.
5. Within a minute the daemon starts on its own — the log will show "Starting Claude Code daemon...".

Credentials are saved to the persistent add-on volume (`/data/.claude/.credentials.json`) and survive restarts.

### Step 2 — Connect via Remote Control

1. Go to [claude.ai/code](https://claude.ai/code) in a browser, or open the Claude mobile app, signed in as the account you just logged in with.
2. Look for the **Remote Control** panel. The session named **Home Assistant** should appear with a green dot indicating it is connected.

If no session appears, confirm the add-on is running and check the log for errors.

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

**Secrets** — No secret (OAuth token, HA access token, agent key) is baked into the Docker image or committed to the repository. All credentials are injected at runtime via add-on options or the persistent volume.

**Container isolation** — Claude runs inside a Docker container managed by the HA Supervisor. It cannot reach host system paths outside its mapped volumes.

**Permissions** — The Remote Control session runs with `--permission-mode auto`, not `--dangerously-skip-permissions`. In that mode Claude judges each action for itself and only raises a permission prompt when it decides one is warranted; those prompts surface in the Remote Control interface, where you answer them from claude.ai/code or the mobile app. Treat that as a convenience, not a containment boundary — the session has a shell and read-write access to your HA config directory. The real safety model is container isolation plus git rollback of your config.

**Assist agent scope** — The Assist surface is a separate `claude -p` process per turn, launched with `--tools ""` and `--strict-mcp-config`. It cannot run a shell, read files or reach the web; its whole capability is Home Assistant's own intent tools over the entities you exposed to Assist.

**HA MCP token** — The Assist agent authenticates to Home Assistant's own MCP server with the Supervisor token the Supervisor injects into the add-on (`homeassistant_api: true` in the manifest). If HA rejects that token on the `/api/mcp/assist` endpoint, create a long-lived access token (Profile → Security) and set it as `ha_mcp_token`; it is used for that endpoint and nothing else. The add-on probes the endpoint once at startup and logs which token it used and whether it worked.

**Git-backed HA config** — The add-on mounts your HA config directory read-write. Before making significant changes, ask Claude to commit a checkpoint so you can roll back with `git revert`.

---

## Cost

This add-on uses your Claude Max or Pro subscription. Token usage accumulates whenever the session is active and processing messages. The session stays warm (running) continuously, which means background keepalive activity also consumes quota. Assist turns are billed on top of that; each one runs under a `$0.50` per-turn budget cap.

Monitor your usage at [claude.ai](https://claude.ai). If you notice high consumption, stop the add-on when not in use.

---

## Troubleshooting

**Add-on log repeats "Claude is not authenticated yet"**

The daemon has no credentials and is retrying every 60 seconds. Complete [Step 1](#step-1--authenticate-with-claude): open the add-on's **Web UI** tab and run `claude auth login` in the terminal. If `claude auth login` itself fails to print a URL, check that the container has outbound internet access, then try again.

---

**Remote Control session does not appear at claude.ai/code**

- Confirm the add-on is running (not stopped or in a restart loop).
- Check the log for `remote-control` errors.
- Make sure you are signed into the same Claude account used during `claude auth login`.
- Remote Control requires Claude Code v2.1.80+; the build enforces this but a stale cached image might bypass the check. Rebuild the image.

---

**The Remote Control session cannot see HA entities**

- Confirm `ha_agent_key` is set. If it is blank, the log says so explicitly and the session starts with no MCP servers at all.
- Confirm the **HA Vibecode Agent** add-on is installed and running, and that `ha_agent_url` points at it (default `http://homeassistant:8099`).
- The startup log prints `Writing HA MCP config (agent URL: …)` when the config was written; its absence means the key was blank.

---

**The Assist agent replies but cannot control anything**

- Check the startup log for the MCP probe. `HA MCP server reachable (HTTP 200)` means it has tools; anything else is printed as a loud multi-line error naming the cause.
- Confirm the **Model Context Protocol Server** integration is installed in HA on the default Assist API.
- Confirm the entities you expect are exposed under **Settings → Voice assistants → Expose**. Claude sees nothing else.
- If the probe reports 401, the Supervisor token was rejected: create a long-lived access token in HA (Profile → Security → Long-Lived Access Tokens), set it as `ha_mcp_token`, and restart the add-on.

More detail, including the exact `curl` commands to test each hop, is in [`docs/ASSIST_DEBUGGING.md`](docs/ASSIST_DEBUGGING.md).
