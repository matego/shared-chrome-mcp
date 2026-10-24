import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListRootsRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { sessionContext } from './session-context.js';
import { waitReady } from './wait-ready.js';

// The same playwright-core copy Playwright MCP runs on, so the pages we hand it are its own kind.
const { chromium } = createRequire(import.meta.resolve('@playwright/mcp'))('playwright-core');

const WAITS_FOR_PAGE = /^browser_(navigate|navigate_back|click|select_option|press_key)$/;
const MAY_LOG_OUT = /^browser_(navigate|click|run_code_unsafe|evaluate)$/;
const LOGOUT = /\b(log|sign)[\s_-]?(out|off)\b|logout|signout|clearCookies/i;
const PAGE_SECTIONS = /^### (Open tabs|Page|Modal state|WebMCP tools|Snapshot)\n/;
const TIMEOUT = { timeout: 10 * 60 * 1000 };

const INSTRUCTIONS = `One always-on, logged-in Chrome shared by every agent on this machine. Your session gets its own window on first use and sees only its own tabs; after navigate, click, back, select or key press the result comes back once the page is ready, with a fresh snapshot, or says plainly that it is not ready. Logins are shared: never log out, and log in yourself when a site asks (a login counts for every agent). Pay only when the human has clearly said to pay for that specific thing. Downloads land in Chrome's download folder (usually ~/Downloads), not in a Playwright download event.`;

const DESCRIPTIONS = {
  browser_close: "Close this session's browser windows. Other agents' windows stay open.",
  browser_tabs: "List, create, close, or select a tab. Only this session's own tabs are visible; a new tab opens as a new window.",
};

const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const failure = message => ({ content: [{ type: 'text', text: `### Error\n${message}` }], isError: true });

export async function serve({ port, version }) {
  const endpoint = `http://127.0.0.1:${port}`;
  let browser, session;

  const playwright = await createConnection({}, async () => {
    if (!browser?.isConnected()) {
      browser = await chromium.connectOverCDP(endpoint).catch(() => {
        throw new Error(`No Chrome on ${endpoint}. Start it with "npx shared-agent-browser start", or keep it running with "npx shared-agent-browser install".`);
      });
      session = sessionContext(browser.contexts()[0]);
    }
    return session.context;
  });

  const server = new Server({ name: 'shared-agent-browser', version }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
  const client = new Client({ name: 'shared-agent-browser', version }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, () =>
    server.getClientCapabilities()?.roots ? server.listRoots() : { roots: [{ uri: pathToFileURL(process.cwd()).href }] });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());

  const [inner, outer] = InMemoryTransport.createLinkedPair();
  await playwright.connect(outer);
  await client.connect(inner);

  const call = (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { ...TIMEOUT, signal });

  // The page as it is once ready: the action's own sections, a readiness verdict, then a fresh snapshot.
  async function whenReady(result) {
    const check = await call('browser_run_code_unsafe', { code: String(waitReady), _meta: { raw: true } });
    const json = !check.isError && text(check).match(/^\{.*\}$/m);
    const r = json ? JSON.parse(json[0]) : { ready: false, error: text(check) };
    const verdict = r.ready
      ? `### Page readiness\nReady after ${r.ms} ms.`
      : `### Page readiness\nNOT READY: ${r.error ?? `network idle ${r.networkIdle}, DOM quiet ${r.domQuiet}, loading indicators ${r.busyIndicators}, waited ${r.ms} ms`}. Conclude nothing from this page yet; check again with browser_snapshot.`;
    const fresh = await call('browser_snapshot', {});
    const kept = text(result).split(/^(?=### )/m).filter(section => !PAGE_SECTIONS.test(section));
    const merged = [...kept, verdict, text(fresh)].map(s => s.trim()).filter(Boolean).join('\n');
    return { ...result, content: [{ type: 'text', text: merged }, ...result.content.filter(part => part.type !== 'text')] };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await client.listTools();
    return { tools: tools.map(tool => DESCRIPTIONS[tool.name] ? { ...tool, description: DESCRIPTIONS[tool.name] } : tool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }, { signal }) => {
    if (MAY_LOG_OUT.test(name) && LOGOUT.test(JSON.stringify(args)))
      return failure("Refused: this looks like logging out or clearing cookies. Every agent shares this browser's logins, so a logout here logs all of them out. If it really has to happen, ask the human to do it.");
    const result = await call(name, args, signal);
    if (name === 'browser_close') await session?.close();
    return WAITS_FOR_PAGE.test(name) && !result.isError ? whenReady(result) : result;
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await session?.close();
    process.exit(0);
  };
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.connect(new StdioServerTransport());
}
