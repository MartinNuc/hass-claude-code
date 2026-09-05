# Claude Code Agent — Home Assistant Add-on

Runs [Claude Code](https://claude.ai/code) on your Home Assistant host and gives you two ways to talk to it.

**Remote Control** — a persistent Claude Code session you drive from [claude.ai/code](https://claude.ai/code) or the Claude mobile app. It has a shell, read-write access to your HA config, and Home Assistant tools over MCP. Ask it to write an automation, debug a template, restructure a dashboard, or explain what changed last week. This is the "configure my house by talking to it" surface, and it works from your phone.

**Assist** — Claude as a Home Assistant conversation agent, so you can use it from the HA chat panel or a voice satellite. Deliberately far more limited: no shell, no files, no web. It can only reach the entities you explicitly expose to Assist.

```
claude.ai/code or mobile app ──▶ Remote Control session ──▶ shell + files + HA tools
HA chat panel or voice ────────▶ Assist agent ───────────▶ your exposed entities only
```

Both run in one container on your HA host, sharing one Claude login and nothing else.

---

## What you need

| Requirement | Notes |
|---|---|
| Home Assistant OS or Supervised | A Container/Core install cannot run add-ons |
| Claude Max or Pro subscription | You log in once, interactively. There is no API-key option. |
| [HA Vibecode Agent](https://github.com/Coolver/home-assistant-mcp) add-on | Optional, but it's what gives the Remote Control session its Home Assistant tools |

---

## Setup

### Step 1 — Add this repository

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FMartinNuc%2Fhass-claude-code)

Click the button above, then **Add**. Or do it by hand: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, paste `https://github.com/MartinNuc/hass-claude-code`.

Find **Claude Code Agent** in the store, click **Install**, then **Start**.

### Step 2 — Log in to Claude

Claude Code needs one interactive login. The add-on ships a web terminal for exactly this.

1. Open the add-on's **Web UI** tab. You get a shell inside the container.
2. Run `claude auth login` and follow the browser flow it prints.
3. Within a minute the log shows `Starting Claude Code daemon...`.

Your credentials are stored on the add-on's own volume and survive restarts and reboots. Until you do this, the log repeats "Claude is not authenticated yet" every 60 seconds — that's expected, not an error.

### Step 3 — Connect Remote Control

Open [claude.ai/code](https://claude.ai/code) or the Claude mobile app, signed in as the account you just used. A session named **Home Assistant** appears in the Remote Control list with a green dot.

That's Remote Control working. It can already use a shell and edit your config. To give it Home Assistant tools as well, continue to step 4.

### Step 4 — Connect Home Assistant tools (optional)

This is what lets the Remote Control session read entity states and deploy changes, rather than only editing YAML by hand.

**Install the HA Vibecode Agent add-on.** It's a separate add-on that exposes Home Assistant over MCP. Install and start it.

**Get its key.** On the Vibecode Agent's page, open the **Web UI** and scroll to **Step 3: Copy Configuration**. You'll see a JSON block containing `HA_AGENT_KEY`. Copy just that key value — the long string in quotes, not the whole block.

> Treat this key like a password. It grants control of your Home Assistant. Don't paste it into a chat, a screenshot, or a public repo. If it ever leaks, the same page has a **Regenerate Key** button.

**Configure this add-on.** Open Claude Code Agent → **Configuration**, paste the key into **HA Vibecode Agent API key**, and leave **HA Vibecode Agent URL** blank — the default `http://homeassistant:8099` works on a standard HAOS install.

Save, then **Restart** the add-on. The log should say `Writing HA MCP config (agent URL: …)`. If it warns that the key is blank instead, the save didn't take.

> If Claude can't reach the agent, set the URL explicitly: on the Vibecode Agent's **Info** tab, under Controls, copy **Hostname** (something like `a22e6bb0-home-assistant-cursor-agent`) and use `http://<that hostname>:8099`. Don't use the `homeassistant.local` address the Vibecode UI suggests — that one is for Cursor or VS Code on your laptop and does not resolve from inside a container.

Ask Claude something like *"what lights do I have?"* from claude.ai/code to confirm.

---

## Setting up Assist

This gives you Claude in the Home Assistant chat panel and on voice satellites.

### Step 1 — Add HA's MCP Server integration

**Settings → Devices & Services → Add Integration → Model Context Protocol Server.** Keep the default **Assist** API.

This is how Claude actually controls your devices during an Assist conversation. Without it Claude will chat happily and control nothing.

There is nothing to configure on the add-on side for this — it reaches Home Assistant through the Supervisor automatically.

### Step 2 — Expose the entities you want it to reach

**Settings → Voice assistants → Expose.** Add your lights, switches, covers, whatever you want reachable.

The Assist agent sees nothing outside this list. That, plus having no shell and no file access, is the whole security model — so this list is worth being deliberate about.

### Step 3 — Restart Home Assistant

The add-on copies its integration into your config directory at startup, and Home Assistant only loads custom integrations at Core startup. **Settings → System → Restart**.

### Step 4 — Add the integration

**Settings → Devices & Services → Add Integration → Claude Code Agent.**

The connection details are pre-filled from the add-on — just click **Submit**.

### Step 5 — Create an agent

On the integration's card, click **Add a Claude agent**:

- **Name** — what you'll see in the pipeline picker
- **Model** — `sonnet` is the default. Use `haiku` for voice, where speed matters more than depth. `opus` for complex requests you're willing to wait a few seconds for.
- **Instructions** — an optional system prompt

You can add several agents with different models and point different pipelines at each.

### Step 6 — Point a pipeline at it

**Settings → Voice assistants → Add assistant** (or edit an existing one) → set **Conversation agent** to the agent you just created.

Talk to it from the Assist icon in the top-right of the sidebar. Try *"which lights are on?"*, then *"turn them off"*.

---

## Options reference

| Option | Default | What it does |
|---|---|---|
| Claude Code Remote Control session name | `Home Assistant` | The name this instance shows at claude.ai/code. Change it if you run Claude Code on more than one machine. |
| HA Vibecode Agent API key | — | From the Vibecode Agent Web UI, step 3. Blank means the Remote Control session starts with no Home Assistant tools. |
| HA Vibecode Agent URL | `http://homeassistant:8099` | Leave blank; the default works on a standard HAOS install. Override with `http://<Vibecode hostname>:8099` from that add-on's Info tab only if it can't connect. |
| Log Claude daemon output (debugging) | off | Noisy debug logging. Turn on only if the Remote Control session never appears. |

---

## Security

**The two surfaces are deliberately unequal.** Remote Control has a shell and read-write access to your HA config; the real boundary is container isolation plus git, not permission prompts. The Assist agent runs each turn as a separate process with every built-in tool disabled and MCP restricted to Home Assistant's intent tools — its entire capability is the entities you exposed.

**Keep your HA config in git.** Every change Claude makes is then committable and revertible. Before any significant work, ask it to commit a checkpoint.

**No secrets are baked into the image or this repository.** Your Claude credentials, HA tokens and the Vibecode agent key exist only at runtime, in the add-on's private volume or its options.

**Nothing is exposed to the internet.** The only ingress is Home Assistant's own, for the web terminal.

---

## Cost

Both surfaces bill against your Claude subscription. The Remote Control session consumes quota whenever it's active. Assist turns bill on top of that, capped at $0.50 per turn — a question is cheap, a request that controls devices costs more because Claude makes several tool calls to fulfil it.

Watch your usage at [claude.ai](https://claude.ai). Stop the add-on when you're not using it if consumption is a concern.

---

## Troubleshooting

**The log repeats "Claude is not authenticated yet"** — Step 2 isn't done. Open the Web UI and run `claude auth login`.

**No Remote Control session at claude.ai/code** — Confirm the add-on is running and you're signed into the same Claude account. If it's still missing, turn on **Log Claude daemon output** and restart; the log will then show what the session is waiting on.

**Remote Control can't see entities** — Step 4. Check the log says `Writing HA MCP config`. If the key is set and it still can't connect, override the Vibecode Agent URL with that add-on's own hostname from its Info tab.

**Assist replies but controls nothing** — Look for `HA MCP server reachable (HTTP 200)` in the add-on log. Anything else is printed as a loud multi-line error naming the cause. Then confirm the Model Context Protocol Server integration is installed and your entities are exposed.

**"Sorry, the Claude add-on isn't responding"** — The integration can't reach the add-on. Check the add-on is running, then look in the HA log for a `Prompt API call failed:` line, which names the underlying cause.

More detail, including the exact `curl` commands to test each hop, is in [`docs/ASSIST_DEBUGGING.md`](docs/ASSIST_DEBUGGING.md).
