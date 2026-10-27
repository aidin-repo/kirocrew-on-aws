// End-to-end sign-in test for Option B, driven through a real browser.
//
// Prerequisites:
//   kubectl -n user-alice port-forward svc/edge 8081:8080     (leave running)
//   kubectl -n user-bob   port-forward svc/edge 8082:8080     (leave running)
//   python3 scripts/set-test-passwords.py                     (writes ~/.kirocrew-eks-poc/passwords.json)
//   PLAYWRIGHT_CORE=<path to playwright-core>  CHROMIUM_PATH=<path to a Chromium binary>
//
// Each case signs one Cognito user in at one pod's edge and checks what the browser ends up with.
// It prints statuses and page titles only. It never prints a password, cookie value or token.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';

import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

// Start the two port-forwards from inside this script, so they live exactly as long as the test does.
const KUBE_CONTEXT = process.env.KUBE_CONTEXT || 'kirocrew-eks-poc';
const forwards = [
  ['alice', 8081],
  ['bob', 8082],
].map(([u, p]) =>
  spawn('kubectl', ['--context', KUBE_CONTEXT, '-n', `user-${u}`, 'port-forward', 'svc/edge', `${p}:8080`], {
    stdio: 'ignore',
  }),
);
const stopForwards = () => forwards.forEach((f) => f.kill());
process.on('exit', stopForwards);
for (const p of [8081, 8082]) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://localhost:${p}/healthz`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const creds = JSON.parse(fs.readFileSync(`${os.homedir()}/.kirocrew-eks-poc/passwords.json`, 'utf8'));
const ports = { alice: 8081, bob: 8082 };
const shotDir = process.env.SHOT_DIR || '/tmp';

const cases = [
  { who: 'alice', port: ports.alice, expect: 'allowed' },
  { who: 'bob', port: ports.bob, expect: 'allowed' },
  { who: 'bob', port: ports.alice, expect: 'denied' },
  { who: 'alice', port: ports.bob, expect: 'denied' },
];

async function run({ who, port, expect }) {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-gpu'],
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const statuses = [];
  page.on('response', (r) => {
    if (r.request().isNavigationRequest() && new URL(r.url()).host === `localhost:${port}`) {
      statuses.push(r.status());
    }
  });

  let outcome = 'error';
  let detail = '';
  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/amazoncognito\.com/, { timeout: 30000 });
    await page.locator('input[name="username"]:visible').first().fill(who);
    await page.locator('input[type="password"]:visible').first().fill(creds[who]);
    await page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => u.host === `localhost:${port}`, { timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const title = await page.title();
    const cookieNames = (await ctx.cookies()).map((c) => c.name).sort();
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
    const last = statuses[statuses.length - 1];
    outcome = last === 403 ? 'denied' : last && last < 400 ? 'allowed' : 'error';
    detail = `http=${last} title="${title}" cookies=[${cookieNames.join(',')}] body="${body}"`;
    await page.screenshot({ path: `${shotDir}/option-b-${who}-at-${port}.png` });
  } catch (e) {
    detail = `exception: ${String(e.message).split('\n')[0]}`;
    await page.screenshot({ path: `${shotDir}/option-b-${who}-at-${port}-error.png` }).catch(() => {});
  } finally {
    await browser.close();
  }

  const ok = outcome === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${who} -> pod on :${port}  expected ${expect}, got ${outcome}\n      ${detail}`);
  return ok;
}

let failed = 0;
for (const c of cases) {
  if (!(await run(c))) failed += 1;
}
console.log(failed === 0 ? '\nAll sign-in cases behaved as expected.' : `\n${failed} case(s) did not behave as expected.`);
process.exit(failed === 0 ? 0 : 1);
