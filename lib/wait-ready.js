// Runs inside Playwright MCP (browser_run_code_unsafe) on the session's current page, so it must not
// use anything from this module. Ready = loaded, network idle, no visible loading indicators, then
// 1 s without DOM changes, all within one 20 s budget.
export const waitReady = async page => {
  const start = Date.now();
  const deadline = start + 20000;
  const left = () => Math.max(deadline - Date.now(), 1);
  const busy = page.locator('[aria-busy="true"], [role="progressbar"], .spinner, .loading, .skeleton').filter({ visible: true });
  await page.waitForLoadState('load', { timeout: left() });
  const networkIdle = await page.waitForLoadState('networkidle', { timeout: left() }).then(() => true, () => false);
  await busy.first().waitFor({ state: 'hidden', timeout: left() }).catch(() => {});
  const domQuiet = await page.evaluate(({ quietMs, ms }) => new Promise(resolve => {
    let timer;
    const done = ok => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(ok); };
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => done(true), quietMs); });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => done(true), quietMs);
    const cap = setTimeout(() => done(false), ms);
  }), { quietMs: 1000, ms: left() });
  const busyIndicators = await busy.count();
  return { ready: networkIdle && domQuiet && busyIndicators === 0, networkIdle, domQuiet, busyIndicators, ms: Date.now() - start };
};
