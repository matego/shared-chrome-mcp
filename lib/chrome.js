import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const cdp = (port, path = 'version') =>
  fetch(`http://127.0.0.1:${port}/json/${path}`, { signal: AbortSignal.timeout(2000) }).then(r => r.json(), () => null);

const processes = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .map(line => line.trim().match(/^(\d+) (.*)$/)).filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command }));

// The Chrome running on this profile, if any (helpers carry --type=, the main process does not).
const profilePid = profile => processes().find(({ command }) => !command.includes('--type=') &&
  (command.includes(`--user-data-dir=${profile} `) || command.endsWith(`--user-data-dir=${profile}`)))?.pid;

// The owner's everyday Chrome: a main Chrome process without a profile of its own.
const ownerPid = () => processes().find(({ command }) =>
  /MacOS\/Google Chrome( --|$)/.test(command) && !command.includes('--type=') && !command.includes('--user-data-dir='))?.pid;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function start(o) {
  // macOS sends Dock clicks and links from other apps to the oldest running Chrome, so the owner's must start first.
  let owner;
  if (o.ownerChromeFirst) {
    if (!ownerPid()) { spawnSync('open', ['-g', '-a', 'Google Chrome']); await sleep(5000); }
    owner = ownerPid();
  }

  // A Chrome already on this profile (started outside this command): watch it, since a second launch
  // would only hand it a new tab and exit.
  let pid = profilePid(o.profile);
  let child;
  if (!pid) {
    if (await cdp(o.port)) throw new Error(`Port ${o.port} is already taken by another browser. Pick another with --port.`);
    mkdirSync(o.profile, { recursive: true });
    child = spawn(o.chrome, [
      `--user-data-dir=${o.profile}`,
      `--remote-debugging-port=${o.port}`,
      // The profile's cookies are encrypted with the mock keychain: launch it any other way and every site shows logged out.
      '--use-mock-keychain',
      '--password-store=basic',
      // Agent windows are often covered by other windows: keep their pages running and visible.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { stdio: 'ignore' });
    pid = child.pid;
    // Stopping this command stops the Chrome it started; the loop below ends once Chrome has closed.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill());
  }

  let up = false;
  for (let i = 0; i < 60 && !(up = !!(await cdp(o.port))); i++) await sleep(500);
  console.log(up ? `Chrome ${pid} on http://127.0.0.1:${o.port}, profile ${o.profile}` : `Chrome ${pid} runs on ${o.profile} but nothing answers on port ${o.port}`);

  while (alive(pid)) {
    await sleep(1000);
    const now = owner && ownerPid();
    // The owner's Chrome restarted (an update, a quit): this one is now the oldest. Exit and let launchd start it again.
    if (now && now !== owner) { process.kill(pid); break; }
  }
}

const uid = () => userInfo().uid;
const plistPath = label => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function install(o) {
  if (process.platform !== 'darwin') throw new Error('install sets up a launchd agent, so it is macOS only. Elsewhere, run "shared-chrome-mcp start" from your init system.');
  const args = [process.execPath, CLI, 'start', '--port', String(o.port), '--profile', o.profile, '--chrome', o.chrome];
  if (o.ownerChromeFirst) args.push('--owner-chrome-first');
  const log = `${o.profile}.log`;
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath(o.label), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`);
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${o.label}`], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath(o.label)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('launchctl bootstrap failed');
  for (let i = 0; i < 60 && !(await cdp(o.port)); i++) await sleep(500);
  console.log(`Installed launchd agent ${o.label} (${plistPath(o.label)}), log ${log}`);
  await status(o);
}

export async function uninstall(o) {
  if (process.platform !== 'darwin') throw new Error('uninstall removes the launchd agent, so it is macOS only.');
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${o.label}`], { stdio: 'ignore' });
  rmSync(plistPath(o.label), { force: true });
  console.log(`Removed launchd agent ${o.label}. The profile stays in ${o.profile}.`);
}

export async function status(o) {
  const version = await cdp(o.port);
  const pages = version ? (await cdp(o.port, 'list') ?? []).filter(t => t.type === 'page').length : 0;
  const pid = profilePid(o.profile);
  console.log(version ? `CDP: up on 127.0.0.1:${o.port}, ${version.Browser}, ${pages} pages open` : `CDP: down on 127.0.0.1:${o.port}`);
  console.log(`Profile: ${o.profile} (${pid ? `Chrome ${pid}` : 'no Chrome running on it'})`);
  if (process.platform === 'darwin') {
    const loaded = spawnSync('launchctl', ['print', `gui/${uid()}/${o.label}`], { stdio: 'ignore' }).status === 0;
    console.log(`launchd: ${o.label} ${loaded ? 'loaded' : 'not installed'}`);
  }
  if (!version) process.exitCode = 1;
}
