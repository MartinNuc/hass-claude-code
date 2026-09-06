# Changelog

## 1.10.1

**Home Assistant now tells you when a restart is needed.** Updating the add-on replaces the integration's files, but Home Assistant keeps running the old ones until Core restarts — so new options simply did not appear, with nothing anywhere explaining why. There is now a repair notice under Settings when that happens, the way HACS does it.

Nothing else changed. If you updated to 1.10.0 and could not find the Effort setting, this was why: restart Home Assistant and it is there.

## 1.10.0

**Restart Home Assistant after updating**, or the new setting will not appear.

**Effort is now configurable per agent**, in the dropdown next to the model: `low`, `medium`, `high`, `xhigh` or `max`. It controls how hard Claude thinks before answering.

Leave it empty and nothing changes — Claude Code's own default applies, which is what your existing agents already do. `low` is worth trying for voice, where a fast answer beats a thorough one. Model and effort are independent, so a fast model thinking hard is a perfectly sensible combination.

## 1.9.0

**Restart Home Assistant after updating**, or the new options will not appear.

**The Assist agent can now do more than switch your lights, if you ask it to.** Both additions are off by default and neither grants shell or file access — that limit is permanent.

**Web search, per agent.** Each Claude agent gets an "Allow web search" checkbox. Turn it on and that agent can search and fetch the web. It makes every turn slower and more expensive, so it suits the chat panel better than a kitchen speaker — which is why it is per agent rather than global. Existing agents keep it off.

**Your own MCP servers.** Add them from the add-on's Web UI terminal and every Assist agent picks them up next to Home Assistant's own:

```bash
claude mcp add --scope user shopping-list -- npx -y your-mcp-server
claude mcp list
```

Worth knowing before you add either: an Assist turn runs **unattended**, and anyone who can talk to a voice satellite can trigger one — there is no permission prompt, because there is no screen to show one on. A server that sends email, spends money or unlocks a door becomes reachable by speech.

## 1.8.1

Release notes now appear in Home Assistant's update dialog instead of "No changelog found". This entry exists so you can see that working — there are no functional changes.

## 1.8.0

**Claude is now available as a Home Assistant Assist conversation agent**, alongside the existing Remote Control session. Talk to it from the HA chat panel or a voice satellite. See the README for setup — it needs HA's Model Context Protocol Server integration and a Home Assistant restart.

The Assist agent is deliberately far more limited than Remote Control: no shell, no file access, no web. Its entire capability is Home Assistant's own intent tools over the entities you expose to Assist.

**⚠️ Breaking: clear `ha_mcp_token` and `ha_url` before updating.** Both options are removed. Home Assistant validates saved options against the add-on schema, so a leftover value for a removed key will stop the add-on from starting.

Six options are now four, and only the Vibecode Agent API key normally needs a value. The two removed options existed for a failure that never happened — Home Assistant rejecting the Supervisor token — while causing a real one: pointed at the Vibecode Agent add-on they returned a confident 404, and the Assist agent came up with no tools while the working default sat unused.

## 1.7.4

Setup no longer asks you to copy the Vibecode Agent's hostname. Measured on real hardware: the default `http://homeassistant:8099` works, so the Vibecode Agent URL can stay blank. The hostname is now documented only as a fallback, along with the fact that the `homeassistant.local` address the Vibecode UI suggests does not resolve from inside a container.

## 1.7.3

A broken MCP override no longer costs you a working default. If a configured endpoint fails and the Supervisor proxy works, the add-on uses the proxy and says loudly in the log that it ignored your settings.

## 1.7.2

README rewritten around the shortest path to a working setup: install, log in, connect Remote Control, then Assist — each with the exact UI path to click. Adds a one-click button for adding the repository.

## 1.7.1

**Fixed: every Assist turn failed with "cannot be used with root/sudo privileges."** From Claude Code 2.1.261 this guard also covers `--permission-mode bypassPermissions`, which the Assist path has always used, and the add-on container runs as root. Arrived as a CLI-version regression rather than a misconfiguration.

Also fixed: a failed turn logged nothing at all, so there was no way to diagnose it from Home Assistant. The underlying cause is now written to the log.

## 1.7.0

**Fixed: the Assist agent could not reach Home Assistant's MCP server.** It pointed at `http://homeassistant:8123`, which does not work on a real HAOS install — that name resolves to the Supervisor network gateway and refuses the connection, and Home Assistant is not on port 8123 on every install. Now uses the Supervisor's Core API proxy, which needs no configuration.

## 1.6.3

**Fixed: a crash loop on fresh installs.** `claude --continue` exits with an error when there is no previous conversation to continue, so the daemon restarted forever. It is now passed only when a conversation exists.

## 1.6.2

**Fixed: the Remote Control session never appeared.** Onboarding state was being written to `settings.json`, which Claude Code does not read it from, so the session sat at the first-run theme picker waiting for a keypress. Because that output was suppressed, the log showed a perfectly healthy startup. State is now seeded into `.claude.json`, merged rather than overwritten so existing state survives.

## 1.6.1

The Remote Control session name is configurable, defaulting to `Home Assistant`. Useful if you run Claude Code on more than one machine.

## 1.6.0

Internal: the add-on now runs an HTTP API for Assist turns and deploys its Home Assistant integration into your config directory.

## 1.5.2

The Remote Control session resumes its previous conversation after a restart or reboot.

## 1.5.1

Removed Claude's terminal output from the add-on log. It is cursor-positioning noise, not readable text. Turn the `debug_daemon_output` option on to get it back when diagnosing a session that will not start.

## 1.5.0

Removed Telegram. Remote Control replaces it and is simpler and more reliable.

## 1.4.x

Remote Control session named `Home Assistant`; first-run theme and workspace-trust wizards answered automatically; `--permission-mode auto` instead of `--dangerously-skip-permissions`, which does not work as root; Claude run inside a PTY so it enters interactive mode.

## 1.3.x

Web terminal rewritten several times before settling on node-pty, so `claude auth login` works reliably through Home Assistant ingress.

## 1.0.0 – 1.2.0

Initial add-on: Claude Code on the Home Assistant host, with a web terminal for the one-time login.
