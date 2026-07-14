// Author: Reza Paramarta (https://github.com/rezaparamarta)
const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, 'auth', 'chrome-profile');
const EXTENSION_PATH = path.join(__dirname, 'zoom-extension');
const SIT_RUN_URL = 'https://app.qase.io/run/YOUR_PROJECT_CODE/dashboard/1/your-run-hash-here';
const SUITE_TEXT = 'Nama Suite Kamu';
const CASE_TEXT = 'Judul Case Kamu';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SIT_RUN_URL);

  const filterInput = page.getByPlaceholder('Search...');
  await filterInput.fill(SUITE_TEXT);
  const caseLocator = page.getByText(CASE_TEXT, { exact: false }).first();
  await caseLocator.waitFor({ state: 'visible', timeout: 15000 });
  await caseLocator.click();
  await page.waitForTimeout(1000);

  const debugPath = path.join(__dirname, 'inspect-case.png');
  await page.screenshot({ path: debugPath, fullPage: false });
  console.log(`Screenshot disimpan: ${debugPath}`);

  // dump teks panel biar kebaca persis step-stepnya
  const panelText = await page.locator('body').innerText();
  console.log('--- PANEL TEXT DUMP ---');
  console.log(panelText.slice(-3000));
})();
