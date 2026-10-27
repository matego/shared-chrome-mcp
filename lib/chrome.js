import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = process.platform === 'win32';

const cdp = (port, path = 'version') =>
  fetch(`http://127.0.0.1:${port}/json/${path}`, { signal: AbortSignal.timeout(2000) }).then(r => r.json(), () => null);

// Every running process with its full command line, one shape on every OS: `ps` carries it on
// macOS/Linux; Windows keeps it nowhere `tasklist` or Node expose, only in WMI/CIM.
const processes = () => {
  if (windows) {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
    ], { encoding: 'utf8' });
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).filter(r => r.CommandLine).map(r => ({ pid: r.ProcessId, command: r.CommandLine }));
  }
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().match(/^(\d+) (.*)$/)).filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command }));
};

// A command-line arg, quoted or not the way each OS happens to report it (Windows quotes paths with spaces).
const hasArg = (command, flag, value) =>
  new RegExp(`${flag}=["']?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?(?:\\s|$)`).test(command);

// The Chrome running on this profile, if any (helpers carry --type=, the main process does not).
const profilePid = profile => processes().find(({ command }) => !command.includes('--type=') && hasArg(command, '--user-data-dir', profile))?.pid;

// The owner's everyday Chrome: a main Chrome process without a profile of its own. Only meaningful on
// macOS, where the Dock and links from other apps always go to the oldest running Chrome.
const ownerPid = () => process.platform === 'darwin' && processes().find(({ command }) =>
  /MacOS\/Google Chrome( --|$)/.test(command) && !command.includes('--type=') && !command.includes('--user-data-dir='))?.pid;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function start(o) {
  if (o.ownerChromeFirst && process.platform !== 'darwin')
    throw new Error('--owner-chrome-first restarts this Chrome whenever the Dock\'s oldest one does, so it is macOS only.');

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
      // Chrome's performance manager overrides the flag above (crbug.com/549552319): a page under its popup tab still drops
      // to background OS priority, and under load a click on it waits seconds for the renderer.
      '--disable-features=PMProcessPriorityPolicy',
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
const loaded = label => spawnSync('launchctl', ['print', `gui/${uid()}/${label}`], { stdio: 'ignore' }).status === 0;

// Task Scheduler has no "write this script's args as a plist" equivalent, so the task just runs a
// tiny launcher script, the same role the plist's ProgramArguments plays on macOS.
const taskDir = join(homedir(), '.shared-chrome-mcp', 'tasks');
const taskScriptPath = label => join(taskDir, `${label}.cmd`);
const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const taskExists = label => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `if (Get-ScheduledTask -TaskName ${psQuote(label)} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
]).status === 0;

async function installWindows(o) {
  if (o.ownerChromeFirst) throw new Error('--owner-chrome-first restarts this Chrome whenever the Dock\'s oldest one does, so it is macOS only.');
  const log = `${o.profile}.log`;
  const script = taskScriptPath(o.label);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(script, [
    '@echo off',
    `"${process.execPath}" "${CLI}" start --port ${o.port} --profile "${o.profile}" --chrome "${o.chrome}" >> "${log}" 2>&1`,
    '',
  ].join('\r\n'));
  const ps = [
    `$action = New-ScheduledTaskAction -Execute ${psQuote(script)}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
    // RestartCount/-Interval is Task Scheduler's KeepAlive: it relaunches the script whenever Chrome exits and "start" with it.
    `$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `Unregister-ScheduledTask -TaskName ${psQuote(o.label)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `Register-ScheduledTask -TaskName ${psQuote(o.label)} -Action $action -Trigger $trigger -Settings $settings | Out-Null`,
    `Start-ScheduledTask -TaskName ${psQuote(o.label)}`,
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Register-ScheduledTask failed');
  for (let i = 0; i < 60 && !(await cdp(o.port)); i++) await sleep(500);
  console.log(`Installed scheduled task ${o.label} (${script}), log ${log}`);
  await status(o);
}

async function uninstallWindows(o) {
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Unregister-ScheduledTask -TaskName ${psQuote(o.label)} -Confirm:$false -ErrorAction SilentlyContinue`], { stdio: 'ignore' });
  // Unlike launchd's SIGTERM, killing a Windows process from outside gives it no chance to run a JS
  // handler, so "start" never gets to close its own Chrome: stop the whole tree directly instead.
  const pid = profilePid(o.profile);
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  rmSync(taskScriptPath(o.label), { force: true });
  console.log(`Removed scheduled task ${o.label}${pid ? ' and stopped its Chrome' : ''}. The profile stays in ${o.profile}.`);
}

export async function install(o) {
  if (windows) return installWindows(o);
  if (process.platform !== 'darwin') throw new Error('install sets up a launchd agent (macOS) or a Scheduled Task (Windows); elsewhere, run "shared-chrome-mcp start" from your init system.');
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
  // bootout returns before the old agent has closed its Chrome and exited; bootstrapping meanwhile fails with "5: Input/output error".
  for (let i = 0; i < 60 && loaded(o.label); i++) await sleep(500);
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath(o.label)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('launchctl bootstrap failed');
  for (let i = 0; i < 60 && !(await cdp(o.port)); i++) await sleep(500);
  console.log(`Installed launchd agent ${o.label} (${plistPath(o.label)}), log ${log}`);
  await status(o);
}

export async function uninstall(o) {
  if (windows) return uninstallWindows(o);
  if (process.platform !== 'darwin') throw new Error('uninstall removes the launchd agent (macOS) or the Scheduled Task (Windows); elsewhere, remove it from your init system.');
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
  if (process.platform === 'darwin') console.log(`launchd: ${o.label} ${loaded(o.label) ? 'loaded' : 'not installed'}`);
  if (windows) console.log(`Scheduled Task: ${o.label} ${taskExists(o.label) ? 'registered' : 'not installed'}`);
  if (!version) process.exitCode = 1;
}
