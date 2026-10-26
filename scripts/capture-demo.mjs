import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
const directory = process.env.AMH_DEMO_DIR;
if (!directory) throw new Error('Set AMH_DEMO_DIR to the running demo data directory');
const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
const browser = await chromium.launch({ headless: true, ...(process.env.AMH_TEST_BROWSER ? { executablePath: process.env.AMH_TEST_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1060 } });
  await page.goto(`http://127.0.0.1:${config.port}`);
  await page.getByLabel('Dashboard administrator token').fill(config.adminToken);
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await page.getByText('Confirmed: I received your question through MCP and replied in the same conversation.', { exact: true }).waitFor();
  await page.screenshot({ path: resolve('docs/dashboard-demo.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('docs/dashboard-mobile.png'), fullPage: true });
  console.log('Saved desktop and mobile demo screenshots. No credentials are included.');
} finally { await browser.close(); }
