// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Jalankan sekali: node login.js
// Browser bakal kebuka, login manual (termasuk SSO/2FA kalo ada).
// Script otomatis deteksi begitu login berhasil (nunggu menu "Dashboards" muncul),
// terus nyimpen session ke auth/qase-storage.json buat dipakai ulang sama main.js.

const { chromium } = require('playwright');
const path = require('path');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 menit buat login manual

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://app.qase.io');

  console.log('\nSilakan login manual di browser yang kebuka (maks 5 menit).');
  console.log('Script bakal lanjut otomatis begitu dashboard kedetek...\n');

  await page.getByRole('link', { name: 'Dashboards' }).first().waitFor({
    state: 'visible',
    timeout: LOGIN_TIMEOUT_MS,
  });

  const storagePath = path.join(__dirname, 'auth', 'qase-storage.json');
  await context.storageState({ path: storagePath });
  console.log(`Login terdeteksi. Session tersimpan di ${storagePath}`);

  await browser.close();
  process.exit(0);
})();
