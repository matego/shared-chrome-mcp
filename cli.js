#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { install, start, status, uninstall } from './lib/chrome.js';

const HELP = `shared-agent-browser: one always-on, logged-in Chrome shared by any number of agents.

Usage:
  shared-agent-browser              run the MCP server (stdio) for your agent
  shared-agent-browser start        launch Chrome on the shared profile and stay with it (foreground)
  shared-agent-browser install      macOS: keep Chrome running with a launchd agent (survives reboots and crashes)
  shared-agent-browser uninstall    macOS: remove the launchd agent (the profile stays)
  shared-agent-browser status       is Chrome up, on which profile, is the launchd agent loaded

Options (or environment variables):
  --port <n>               CDP port on 127.0.0.1 (SHARED_AGENT_BROWSER_PORT, default 9222)
  --profile <dir>          Chrome profile directory (SHARED_AGENT_BROWSER_PROFILE, default ~/.shared-agent-browser/profile)
  --chrome <path>          Chrome binary (SHARED_AGENT_BROWSER_CHROME)
  --label <name>           launchd label (SHARED_AGENT_BROWSER_LABEL, default shared-agent-browser)
  --owner-chrome-first     macOS: start your own Chrome first and restart this one whenever yours restarts,
                           so the Dock and links from other apps keep opening in yours (SHARED_AGENT_BROWSER_OWNER_CHROME_FIRST=1)
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    profile: { type: 'string' },
    chrome: { type: 'string' },
    label: { type: 'string' },
    'owner-chrome-first': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const env = process.env;
const defaultChrome = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome';
const profile = (flags.profile ?? env.SHARED_AGENT_BROWSER_PROFILE ?? '~/.shared-agent-browser/profile').replace(/^~(?=\/|$)/, homedir());

const options = {
  port: Number(flags.port ?? env.SHARED_AGENT_BROWSER_PORT ?? 9222),
  profile: resolve(profile),
  chrome: flags.chrome ?? env.SHARED_AGENT_BROWSER_CHROME ?? defaultChrome,
  label: flags.label ?? env.SHARED_AGENT_BROWSER_LABEL ?? 'shared-agent-browser',
  ownerChromeFirst: flags['owner-chrome-first'] ?? env.SHARED_AGENT_BROWSER_OWNER_CHROME_FIRST === '1',
};

const command = positionals[0] ?? 'serve';
const commands = { start, install, uninstall, status };

if (flags.help || command === 'help') {
  console.log(HELP);
} else if (command === 'serve') {
  const { serve } = await import('./lib/server.js');
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
  await serve({ port: options.port, version });
} else if (commands[command]) {
  await commands[command](options).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}
