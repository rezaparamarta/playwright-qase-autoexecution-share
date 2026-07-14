// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Script debug sekali-pakai: buka case ID 354 di run SIT dan cek langsung
// kenapa collectEvidenceForStep melaporkan "tidak ada evidence" utk step 1,
// padahal user bilang ada gambarnya di SIT. Tidak menyentuh UAT sama
// sekali -- read-only, aman dijalankan berkali-kali.
const { chromium } = require('playwright');
const path = require('path');
const {
  PROJECT_NAME,
  SIT_RUN_PATTERN,
  USER_DATA_DIR,
  EXTENSION_PATH,
  PROJECTS_URL,
} = require('./config');

const SELECTORS = {
  searchPlaceholder: 'Search...',
  caseTitleLink: 'a.FA39Zq',
  stepHeader: 'div._1csvRZ',
  evidenceGalleryClass: 'guirWS',
};
const TEXT = { actualResultValue: 'As Expected' };

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-rasterization',
      '--disable-accelerated-2d-canvas',
      '--disable-accelerated-video-decode',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(PROJECTS_URL);

  const searchInput = page.getByRole('textbox').first();
  await searchInput.fill(PROJECT_NAME);
  await page.getByRole('link', { name: PROJECT_NAME, exact: true }).first().click();
  await page.getByRole('link', { name: 'Test Runs' }).click();
  await page.getByRole('link', { name: SIT_RUN_PATTERN }).click();

  // Cari case ID 354 lewat search box -- ini debug sekali-pakai untuk 1
  // case spesifik, jadi keterbatasan reliabilitas search "by all fields"
  // (yang bikin main.js menghindarinya utk full scan) tidak masalah di sini.
  const filterInput = page.getByPlaceholder(SELECTORS.searchPlaceholder);
  await filterInput.fill('Judul Case Kamu');
  await page.waitForTimeout(1500);

  const link = page.locator(SELECTORS.caseTitleLink).first();
  console.log('Case link ditemukan, teksnya:', await link.textContent());
  await link.click();
  await page.waitForTimeout(1000);

  // Expand step 1 (case ini cuma 1 step)
  const stepHeader = page.locator(SELECTORS.stepHeader).first();
  await stepHeader.waitFor({ state: 'attached', timeout: 15000 });
  await stepHeader.click();
  await page.waitForTimeout(1500);

  const allImgs = await page.evaluate(() => Array.from(document.querySelectorAll('img')).map((img) => ({
    src: img.src,
    className: img.className,
    width: img.naturalWidth,
    height: img.naturalHeight,
  })));
  console.log('Semua <img> di halaman setelah step diexpand:', JSON.stringify(allImgs, null, 2));

  const asExpectedCount = await page.getByText(TEXT.actualResultValue, { exact: true }).count();
  console.log('Jumlah teks "As Expected" ditemukan:', asExpectedCount);

  const galleryEls = await page.evaluate((galleryClass) =>
    document.querySelectorAll(`.${galleryClass}`).length, SELECTORS.evidenceGalleryClass);
  console.log('Jumlah elemen dengan class evidence gallery:', galleryEls);

  // Verifikasi logic findEvidenceUrlsForStep versi baru (berbasis struktur field, bukan teks)
  const newLogicUrls = await page.evaluate(
    ({ stepNumber, stepHeaderSelector, fieldSelector, fieldHeaderSelector, fieldLabel, galleryClass }) => {
      const headers = Array.from(document.querySelectorAll(stepHeaderSelector));
      let startEl = headers.find((h) => h.getAttribute('title') === String(stepNumber));
      if (!startEl) startEl = headers[stepNumber - 1];
      if (!startEl) return [];
      const endEl = headers[headers.indexOf(startEl) + 1] ?? null;
      function isInStepRange(el) {
        const atOrAfterStart = el === startEl || !!(startEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const beforeEnd = !endEl || (el !== endEl && !!(el.compareDocumentPosition(endEl) & Node.DOCUMENT_POSITION_FOLLOWING));
        return atOrAfterStart && beforeEnd;
      }
      const fieldBlocks = Array.from(document.querySelectorAll(fieldSelector)).filter(isInStepRange);
      const actualResultBlock = fieldBlocks.find((block) => {
        const header = block.querySelector(fieldHeaderSelector);
        return header && header.textContent.trim() === fieldLabel;
      });
      if (!actualResultBlock) return [];
      const galleryEl = actualResultBlock.querySelector(`.${galleryClass}`);
      if (!galleryEl) return [];
      return Array.from(galleryEl.querySelectorAll('img')).map((img) => img.src);
    },
    { stepNumber: 1, stepHeaderSelector: SELECTORS.stepHeader, fieldSelector: '.IE130E', fieldHeaderSelector: 'h4.oKbAlD', fieldLabel: 'Actual result', galleryClass: SELECTORS.evidenceGalleryClass }
  );
  console.log('Hasil findEvidenceUrlsForStep versi BARU:', newLogicUrls);

  const stepBodyHtml = await stepHeader.locator('xpath=..').evaluate((el) => el.outerHTML);
  console.log('--- HTML step body (case 354) ---');
  console.log(stepBodyHtml);

  await page.screenshot({ path: path.join(__dirname, 'debug-case354-sit.png'), fullPage: true });
  console.log('Screenshot tersimpan: debug-case354-sit.png');

  console.log('Selesai. Browser dibiarkan terbuka untuk inspeksi manual -- tutup manual kalau sudah cukup.');
})();
