---
name: shared-browser
description: Rules for the shared logged-in Chrome (the browser_* tools of the shared-agent-browser MCP server). Read before any browser work - logins, payments, downloads, popups, parallel agents, and what to do when Chrome is down.
---

# Shared browser

One Chrome, on its own profile, runs all the time and every agent on this machine uses it at once: Claude Code sessions, Codex, Cursor, anything with the MCP server. Its logins belong to all of them. The server already gives your session its own window, keeps you in it, waits for the page after navigate, click, back, select or key press, and closes your windows when the session ends. You do the rest:

- **Use only this browser for web work that needs a login.** Do not launch another Chrome or a second browser tool on the same sites. Claude in Chrome is blocked on purpose: it refuses to log in.
- **Log in yourself** when a site asks, with the credentials the human keeps for agents. A login made here counts for every agent. Hand it to the human only when it needs them (a 2FA code on their phone, a CAPTCHA you cannot pass).
- **Never log out**, never clear cookies or site data: every agent loses that login. The server refuses obvious logout clicks and URLs, but not every one.
- **Pay only on an explicit go-ahead** from the human for that specific purchase. Without one, stop at checkout and ask. Chrome's saved-card autofill popup does not react to automation.
- **Downloads** land in Chrome's download folder (usually `~/Downloads`), not in a Playwright download event. Move the file from there.
- **Not ready** in a result means the page was still loading or changing when the wait gave up: conclude nothing from it; call `browser_snapshot` again, or `browser_wait_for` a text you expect.
- **Popups:** a link that opens a new tab puts it in your window, where it hides your first page. Work in it with `browser_tabs` `select`, then `browser_tabs` `close` it.
- **One browser job per session.** Subagents share their parent's MCP server and so its current tab: run one browser subagent at a time. For parallel browser jobs, run separate sessions (for example `claude -p "<job>"` per job).
- **When done**, `browser_close` closes your windows; other agents' windows stay.

## Chrome is down

A tool error says `No Chrome on http://127.0.0.1:<port>`.
1. `node "${CLAUDE_PLUGIN_ROOT}/cli.js" status` shows whether Chrome is up and whether the launchd agent is installed.
2. Installed (macOS): `launchctl kickstart -k gui/$(id -u)/shared-agent-browser`. Its log is the profile path plus `.log` (default `~/.shared-agent-browser/profile.log`).
3. Not installed: start it in the background with `node "${CLAUDE_PLUGIN_ROOT}/cli.js" start`, and tell the human that `install` keeps it running for good.
4. Your windows are gone after a restart; the next browser call opens a new one. If every site now shows logged out, Chrome was started some other way: it must run with the mock-keychain flags, which only `start` passes.
