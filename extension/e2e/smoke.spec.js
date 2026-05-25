import { test, expect, chromium } from '@playwright/test';
import path from 'path';
import os from 'os';

test('popup loads without errors', async () => {
  const pathToExtension = path.resolve('./dist');
  const userDataDir = path.join(os.tmpdir(), `playwright-ext-test-${Date.now()}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
  });

  // Wait for the service worker to register so we can read the extension ID
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  const extensionId = serviceWorker.url().split('/')[2];

  const page = await context.newPage();

  // Capture console messages at error level and above
  const errors = [];
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (msg.type() === 'warning') warnings.push(msg.text());
  });

  page.on('pageerror', (err) => {
    errors.push(err.message);
  });

  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.waitForLoadState('networkidle');

  // The popup should render the login view (unauthenticated in a fresh profile)
  const heading = page.locator('h1');
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText('gnbedge');

  // Ensure the React root container is present
  await expect(page.locator('#root')).toBeVisible();

  await page.screenshot({ path: 'test-results/popup.png', fullPage: true });

  if (warnings.length) {
    console.log('Console warnings:', warnings);
  }

  expect(errors).toEqual([]);

  await context.close();
});
