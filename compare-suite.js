// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Script diagnostik satu-kali: membandingkan daftar case (semua status) di
// suite yang sama antara run SIT dan UAT, untuk mencari tahu kenapa case
// yang ketemu di UAT sering tidak ketemu saat dicari di SIT.
// Jalankan lewat: node compare-suite.js

const { chromium } = require('playwright');
const {
  PROJECT_NAME,
  SIT_RUN_PATTERN,
  UAT_RUN_PATTERN,
  USER_DATA_DIR,
  EXTENSION_PATH,
  PROJECTS_URL,
} = require('./config');

const SUITE_TEXT = 'Nama Suite Kamu';

const SELECTORS = {
  searchPlaceholder: 'Search...',
  scrollContainer: 'div.U3046o div[style*="overflow: auto"]',
  caseTitleCell: '[aria-labelledby^="title_"]',
  caseTitleLink: 'a.FA39Zq',
  caseIdCell: '[aria-labelledby^="id_"]',
  caseStatusBadge: '[aria-labelledby^="status_"] .KLTPLy',
  suiteHeader: 'h3.IwWVFW',
};

async function gotoWithRetry(pg, url) {
  for (let i = 0; i < 3; i++) {
    try {
      await pg.goto(url);
      return;
    } catch (err) {
      await pg.waitForTimeout(1500);
      if (i === 2) throw err;
    }
  }
}

// Sama seperti listUntestedCasesInSuite di main.js, tapi tanpa filter
// status -- di sini yang mau dilihat justru SEMUA case, biar ketauan
// selisih judul antara SIT & UAT apa adanya.
async function listAllCasesInSuite(pg, suiteText) {
  const filterInput = pg.getByPlaceholder(SELECTORS.searchPlaceholder);
  await filterInput.fill('');
  await pg.locator(SELECTORS.caseTitleCell).first().waitFor({ state: 'attached', timeout: 15000 });

  const scrollContainer = pg.locator(SELECTORS.scrollContainer).first();
  await scrollContainer.waitFor({ state: 'attached', timeout: 15000 });

  const collected = new Map();
  const suiteHeaderTops = new Map();

  const scanPasses = 2;
  for (let pass = 1; pass <= scanPasses; pass++) {
    await scrollContainer.evaluate((el) => { el.scrollTop = 0; });
    await pg.waitForTimeout(500);

    let lastScrollTop = -1;
    let stableReads = 0;
    const maxScrollSteps = 500;
    for (let i = 0; i < maxScrollSteps; i++) {
      const data = await pg.evaluate((sel) => {
        function getAbsoluteTop(el) {
          let node = el;
          while (node) {
            if (node.style && node.style.position === 'absolute' && node.style.top) {
              return parseFloat(node.style.top);
            }
            node = node.parentElement;
          }
          return null;
        }
        const rows = Array.from(document.querySelectorAll(sel.caseTitleCell)).map((titleEl) => {
          const row = titleEl.parentElement;
          const statusEl = row?.querySelector(sel.caseStatusBadge);
          const titleLink = titleEl.querySelector(sel.caseTitleLink);
          let caseId = null;
          const idElByAria = row?.querySelector(sel.caseIdCell);
          if (idElByAria) {
            caseId = idElByAria.textContent.trim();
          } else if (row) {
            const numericCandidate = Array.from(row.querySelectorAll('span, div'))
              .map((el) => el.textContent.trim())
              .find((t) => /^\d+$/.test(t));
            caseId = numericCandidate ?? null;
          }
          return {
            title: titleLink ? titleLink.textContent.trim() : null,
            status: statusEl ? statusEl.textContent.trim() : null,
            top: getAbsoluteTop(titleEl),
            caseId,
          };
        });
        const suiteHeaders = Array.from(document.querySelectorAll(sel.suiteHeader)).map((h) => ({
          name: h.textContent.trim(),
          top: getAbsoluteTop(h),
        }));
        return { rows, suiteHeaders };
      }, SELECTORS);

      for (const row of data.rows) {
        if (!row.title || row.top == null) continue;
        const key = row.caseId ?? `${row.title}__${row.top}`;
        collected.set(key, row);
      }
      for (const header of data.suiteHeaders) {
        if (header.top != null) suiteHeaderTops.set(header.name, header.top);
      }

      const scrollInfo = await scrollContainer.evaluate((el) => ({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      const atBottom = scrollInfo.scrollTop + scrollInfo.clientHeight >= scrollInfo.scrollHeight - 5;
      if (scrollInfo.scrollTop === lastScrollTop || atBottom) {
        stableReads++;
        if (stableReads >= 3) break;
      } else {
        stableReads = 0;
      }
      lastScrollTop = scrollInfo.scrollTop;
      await scrollContainer.evaluate((el) => {
        el.scrollTop += Math.round(el.clientHeight * 0.4);
      });
      await pg.waitForTimeout(700);
    }
    console.log(`  Scan pass ${pass}/${scanPasses} selesai, ${collected.size} judul terkumpul sejauh ini`);
  }

  const targetTop = suiteHeaderTops.get(suiteText);
  if (targetTop == null) {
    throw new Error(`Suite header "${suiteText}" tidak ditemukan (suite yang terdeteksi: ${Array.from(suiteHeaderTops.keys()).join(', ')})`);
  }
  const boundaryTop = Math.min(
    ...Array.from(suiteHeaderTops.values()).filter((top) => top > targetTop),
    Infinity
  );

  const inRange = Array.from(collected.values()).filter((info) => info.top > targetTop && info.top < boundaryTop);

  const seenKeys = new Set();
  return inRange
    .sort((a, b) => a.top - b.top)
    .map((info) => ({ title: info.title, caseId: info.caseId, status: info.status }))
    .filter((c) => {
      const key = c.caseId ?? c.title;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
}

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

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await gotoWithRetry(page, PROJECTS_URL);
    if (page.url().includes('/login')) {
      console.log('Belum login di profile ini. Silakan login manual (maks 5 menit)...');
      await page.waitForURL(/\/projects/, { timeout: 5 * 60 * 1000 });
      await gotoWithRetry(page, PROJECTS_URL);
    }

    const searchInput = page.getByRole('textbox').first();
    await searchInput.fill(PROJECT_NAME);
    await page.getByRole('link', { name: PROJECT_NAME, exact: true }).first().click();
    await page.getByRole('link', { name: 'Test Runs' }).click();

    const [uatPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: UAT_RUN_PATTERN }).click({ modifiers: ['Control'] }),
    ]);
    await uatPage.waitForLoadState();
    await page.getByRole('link', { name: SIT_RUN_PATTERN }).click();

    console.log(`\nMemindai suite "${SUITE_TEXT}" di SIT...`);
    const sitCases = await listAllCasesInSuite(page, SUITE_TEXT);
    console.log(`SIT: ${sitCases.length} case ditemukan.`);

    console.log(`\nMemindai suite "${SUITE_TEXT}" di UAT...`);
    const uatCases = await listAllCasesInSuite(uatPage, SUITE_TEXT);
    console.log(`UAT: ${uatCases.length} case ditemukan.`);

    const sitTitles = new Set(sitCases.map((c) => c.title));
    const uatTitles = new Set(uatCases.map((c) => c.title));

    const onlyInUat = uatCases.filter((c) => !sitTitles.has(c.title));
    const onlyInSit = sitCases.filter((c) => !uatTitles.has(c.title));

    console.log('\n=== HASIL PERBANDINGAN ===');
    console.log(`Total case SIT: ${sitCases.length}`);
    console.log(`Total case UAT: ${uatCases.length}`);
    console.log(`\nCase yang ADA di UAT tapi judulnya TIDAK ketemu persis di SIT (${onlyInUat.length}):`);
    for (const c of onlyInUat) console.log(`  - "${c.title}" (status UAT: ${c.status}, ID: ${c.caseId})`);
    console.log(`\nCase yang ADA di SIT tapi judulnya TIDAK ketemu persis di UAT (${onlyInSit.length}):`);
    for (const c of onlyInSit) console.log(`  - "${c.title}" (status SIT: ${c.status}, ID: ${c.caseId})`);

    console.log('\nSelesai.');
  } finally {
    await context.close();
  }
})();
