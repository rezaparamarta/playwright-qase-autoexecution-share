// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Menyalin evidence hasil eksekusi SIT ke UAT dan menandai case Passed di
// Qase, untuk satu suite dalam satu waktu (lihat SUITE_TEXT di bawah).
// Jalankan lewat: node main.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  PROJECT_NAME,
  SIT_RUN_PATTERN,
  UAT_RUN_PATTERN,
  USER_DATA_DIR,
  EXTENSION_PATH,
  PROJECTS_URL,
  EVIDENCE_SIT_DIR,
} = require('./config');
const {
  MASKING_ENABLED,
  initMaskingWorker,
  shutdownMaskingWorker,
  maskEvidenceImage,
  writeMaskingManifest,
  EvidenceMaskingError,
} = require('./evidence-masking');

// ---------------------------------------------------------------------------
// Konfigurasi -- sesuaikan bagian ini kalau mengarahkan script ke run atau
// suite yang berbeda (untuk project/run Qase yang beda, lihat config.js).
// ---------------------------------------------------------------------------

const SUITE_TEXT = 'Nama Suite Kamu';
// Batasi ke judul case tertentu untuk uji coba cepat; null = proses semua case Untested di suite.
const CASE_TITLE_ALLOWLIST = null;

const RETRY_ATTEMPTS = 3;
// Berapa kali coba buka-ulang case & ulangi step-nya kalau drawer SIT
// ketahuan nyasar ke case lain (lihat DrawerMismatchError) sebelum
// akhirnya benar-benar menyerah dan menghentikan seluruh run.
const DRAWER_RECOVERY_ATTEMPTS = 2;
const MAX_LAUNCH_ATTEMPTS = 5;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const RELAUNCH_DELAY_MS = 3000;

// Semua angka timing (timeout/jeda/jumlah-polling) yang dipakai di
// seluruh script dikumpulkan di sini -- nilainya hasil percobaan empiris
// terhadap perilaku nyata Qase (lihat komentar di tiap pemakaian untuk
// alasan spesifiknya), bukan dari dokumentasi resmi. Dikumpulkan di satu
// tempat (sama seperti SELECTORS/TEXT) supaya kalau Qase berubah
// perilaku timing-nya nanti, cukup disetel ulang di sini -- tidak perlu
// diburu satu per satu di tengah logika.
const TIMING = {
  // Batas waktu default nunggu elemen pertama (list case / step header)
  // muncul di halaman yang baru dibuka/reload.
  elementAttachTimeoutMs: 15000,

  // openCase: dicoba beberapa kali DI POSISI YANG SAMA setelah loncat
  // scroll ke posisi yang sudah diketahui, sebelum fallback ke scroll
  // manual dari awal suite.
  openCaseJumpRetries: 5,
  openCaseJumpRetryDelayMs: 300,
  // Loncatan awal ke posisi yang sudah diketahui sengaja dimundurkan
  // sedikit (30% tinggi viewport) supaya row target tidak nempel persis
  // di tepi atas -- kasih ruang render sebelum row itu genap terlihat.
  openCaseJumpOffsetRatio: 0.3,
  openCaseFallbackScrollDelayMs: 500,
  openCaseFallbackStepRatio: 0.15,
  openCaseFallbackMaxScrollSteps: 60,

  // Default scrollSearch kalau caller tidak menyetel stepRatio/maxScrollSteps sendiri.
  scrollSearchDefaultStepRatio: 0.4,
  scrollSearchDefaultMaxScrollSteps: 200,

  // Jeda antar-langkah scroll virtualized-list, dipakai bareng oleh
  // scanSuite & scrollSearch -- sengaja DISAMAKAN di kedua tempat supaya
  // baris yang baru selesai render tidak kelewat cek di salah satunya.
  scrollStepDelayMs: 700,

  // scanSuite: dua kali scroll penuh dari atas ke bawah (union hasil),
  // ditambah berapa kali scrollTop harus "diam" berturut-turut sebelum
  // dianggap sudah mentok.
  scanPasses: 2,
  scanResetDelayMs: 500,
  scanStableReads: 3,
  scanMaxScrollSteps: 500,
  scanScrollRatio: 0.4,

  // Step list (SIT/UAT) butuh waktu render ulang setelah drawer
  // dibuka/reopen -- dipakai bareng oleh getOrderedStepTexts &
  // collectEvidenceForStep (reopen recovery) supaya keduanya tetap
  // konsisten satu sama lain.
  stepListStableIntervalMs: 200,
  stepListStableReads: 2,
  stepListStableMaxIterations: 15,

  // collectEvidenceForStepOnce: jeda setelah klik-expand step sebelum
  // mulai polling evidence, lalu polling itu sendiri sampai jumlah
  // gambar yang kebaca stabil.
  evidenceExpandDelayMs: 800,
  evidencePollIntervalMs: 300,
  evidencePollMaxIterations: 20,
  evidencePollStableReads: 3,

  // assignToMeIfNeeded: jeda supaya request assign & reload benar-benar
  // selesai diproses server sebelum lanjut (networkidle nyaris tidak
  // pernah tercapai di app ini).
  assignRequestSettleMs: 1000,
  assignReloadSettleMs: 1500,

  // validateStepCountMatches: nunggu jumlah step header di UAT stabil
  // dulu sebelum dibandingkan dengan jumlah dari SIT.
  stepCountStableIntervalMs: 300,
  stepCountStableReads: 2,
  stepCountStableMaxIterations: 20,

  // attachEvidenceToStep: polling sampai jumlah <img> yang ke-upload
  // mencapai ekspektasi.
  uploadPollIntervalMs: 500,
  uploadPollMaxIterations: 60,

  // processCase: jeda setelah klik verdict keseluruhan case supaya
  // request-nya ke-submit ke server dulu sebelum lanjut ke case
  // berikutnya.
  caseVerdictSettleMs: 1000,

  // verifyCaseMarkedPassed: polling status case di panel list sampai
  // benar-benar berubah jadi Passed.
  verdictConfirmIntervalMs: 500,
  verdictConfirmMaxIterations: 10,

  // gotoWithRetry: jeda setelah navigasi gagal (network stack Chrome
  // belum siap sesaat setelah relaunch) sebelum dicoba lagi.
  navRetryDelayMs: 1500,
};

// Qase merender lewat class name hasil generate/minify, jadi selector di
// bawah ini rapuh secara alami. Dikumpulkan di satu tempat supaya
// perubahan markup cukup diperbaiki sekali, tidak perlu dicari satu per
// satu di seluruh file.
const SELECTORS = {
  searchPlaceholder: 'Search...',
  scrollContainer: 'div.U3046o div[style*="overflow: auto"]',
  caseTitleCell: '[aria-labelledby^="title_"]',
  caseTitleLink: 'a.FA39Zq',
  caseIdCell: '[aria-labelledby^="id_"]',
  caseStatusBadge: '[aria-labelledby^="status_"] .KLTPLy',
  suiteHeader: 'h3.IwWVFW',
  stepHeader: 'div._1csvRZ',
  stepVerdictButtonClass: 'dOXGAl',
  caseVerdictButtonClass: 'eN64-o',
  assignToMeScope: 'div.N7cACH',
  evidenceGalleryClass: 'guirWS',
  stepFieldClass: 'IE130E',
  stepFieldHeaderClass: 'h4.oKbAlD',
};

const TEXT = {
  // Fallback Actual result kalau step-nya tidak punya Expected result yang
  // kebaca (lihat findStepFieldsForStep) -- bukan lagi nilai yang selalu
  // dipakai, cuma jaring pengaman.
  actualResultValue: 'As Expected',
  actualResultFieldLabel: 'Actual result',
  expectedResultFieldLabel: 'Expected result',
  passedLabel: 'Passed',
  assignToMeLabel: 'Assign to me',
  addAttachmentLabel: 'Add attachment',
};

// Dilempar saat evidence sudah dipastikan ada di SIT tapi gagal didownload
// atau gagal diverifikasi ke-upload ke UAT. Beda dari error biasa (yang
// cuma nge-skip 1 case), error ini menghentikan seluruh run -- integritas
// evidence tidak boleh diasumsikan begitu saja.
class EvidenceIntegrityError extends Error {}

// Subclass khusus untuk kasus "drawer SIT ternyata nyasar ke case lain"
// (lihat isDrawerShowingCase) -- dibedakan dari EvidenceIntegrityError
// biasa supaya collectEvidenceForStep tahu ini kasus yang AMAN dicoba
// pulihkan (buka ulang case yang benar lalu ulangi step-nya), beda dari
// kegagalan integritas lain (download gagal, dst) yang tidak boleh
// dicoba lagi begitu saja.
class DrawerMismatchError extends EvidenceIntegrityError {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Menjalankan `task` sampai berhasil atau kehabisan percobaan, sambil
// mencatat tiap kegagalan. Dipakai untuk aksi Playwright yang sesekali
// flaky (navigasi, klik di list yang lagi re-render).
async function retry(label, attempts, task) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      lastError = err;
      console.log(`${label} - percobaan ${attempt}/${attempts} gagal: ${err.message.split('\n')[0]}`);
    }
  }
  throw lastError;
}

// Mem-poll `readCount` sampai nilainya sama pada `requiredStableReads` kali
// berturut-turut (atau `maxIterations` habis). Dipakai tiap kali daftar di
// UI masih berpotensi bertambah (step list, thumbnail evidence) dan kita
// perlu tahu kapan render-nya benar-benar selesai sebelum membaca panjangnya.
async function waitForStableCount(readCount, { intervalMs, requiredStableReads, maxIterations }) {
  let lastCount = -1;
  let stableReads = 0;
  for (let i = 0; i < maxIterations; i++) {
    const current = await readCount();
    if (current === lastCount) {
      stableReads++;
      if (stableReads >= requiredStableReads) break;
    } else {
      stableReads = 0;
      lastCount = current;
    }
    await sleep(intervalMs);
  }
  return lastCount;
}

// Mem-poll `check` sampai balikin true, atau `maxIterations` habis.
async function pollUntil(check, { intervalMs, maxIterations }) {
  for (let i = 0; i < maxIterations; i++) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Meniru perilaku Chrome: kalau nama file sudah terpakai, tambahkan
// " (1)", " (2)", dst.
function nextAvailableFilename(dir, base, ext) {
  let candidate = `${base}${ext}`;
  let suffix = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${suffix})${ext}`;
    suffix++;
  }
  return candidate;
}

// Dipanggil di tiap titik kegagalan untuk menyimpan bukti visual state
// halaman. Kalau screenshot-nya sendiri gagal (page/browser sudah
// closed), diamkan saja -- jangan sampai menutupi error asli yang sedang
// ditangani caller.
async function saveDebugScreenshot(page, filename) {
  const debugPath = path.join(__dirname, filename);
  try {
    await page.screenshot({ path: debugPath, fullPage: false });
    console.log(`Screenshot debug disimpan: ${debugPath}`);
  } catch {
    console.log(`Screenshot debug gagal disimpan (page kemungkinan sudah closed): ${debugPath}`);
  }
}

// Menjalankan `action`; kalau gagal, simpan screenshot dari `page` sebelum
// error-nya dilempar ulang.
async function withFailureScreenshot(page, screenshotName, action) {
  try {
    return await action();
  } catch (err) {
    await saveDebugScreenshot(page, screenshotName);
    throw err;
  }
}

// Chrome yang crash (misal GPU crash) kadang meninggalkan file lock di
// profile dir walau prosesnya sudah mati. Kalau tidak dibersihkan, launch
// berikutnya ke USER_DATA_DIR yang sama bisa gagal atau menggantung. Aman
// dihapus -- cuma marker proses, bukan data profile/login.
function clearStaleSingletonLock() {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.unlinkSync(path.join(USER_DATA_DIR, name));
    } catch {
      // Tidak ada file itu, atau masih dipegang proses lain yang benar-benar hidup -- lewati.
    }
  }
}

// Membedakan "browser/tab crash di tengah proses case ini" (case harus
// dicoba ulang di attempt berikutnya) dari "case ini gagal karena
// data/DOM" (tidak perlu diulang). Playwright selalu menyisipkan salah
// satu frasa ini ke error message-nya kalau target (page/context/browser)
// sudah hilang.
function isTargetClosedError(err) {
  return /has been closed|Target closed|Target page/i.test(err?.message ?? '');
}

// Panel test case di-virtualize (row di luar viewport tidak dirender), jadi
// scroll manual gampang overshoot atau flaky. Search box sempat dipakai
// untuk mempersempit pencarian, tapi search "by all fields" milik Qase
// terbukti tidak reliable -- kadang menampilkan case lain yang tidak
// nyambung, kadang tidak menampilkan case yang justru dicari. Pendekatan
// yang dipakai sekarang: kosongkan search box (tampilkan semua case),
// scroll manual dari atas sambil mencari row yang cocok dalam rentang
// pixel suite yang benar.
//
// Rentang suite (suiteBounds.top .. suiteBounds.boundaryTop) dipakai buat
// menyaring row -- BUKAN "suite header mana yang kebetulan masih
// ke-render duluan di DOM saat ini". Percobaan awal memakai cara kedua
// itu dan gagal terus untuk suite yang posisinya jauh di bawah/besar:
// begitu discroll cukup jauh, suite header-nya sendiri sudah ke-unmount
// duluan (virtualized), jadi row-row case di bawahnya keanggep masih
// milik suite lain padahal keliatan jelas di layar. Posisi pixel absolut
// tidak kena masalah itu karena sudah dihitung sekali di awal lewat
// scanSuite (lihat definisinya) dan tidak bergantung render saat ini.
//
// Dicocokkan lewat ID case (kolom "ID" di tabel) kalau tersedia -- ID
// adalah identifier yang stabil dan sama persis antara SIT & UAT (SIT &
// UAT adalah hasil cloning), sedangkan judul case kadang diedit beda
// tipis di salah satu sisi setelah cloning sehingga matching lewat judul
// saja bisa gagal padahal case-nya sama. Matching lewat judul cuma
// dipakai sebagai fallback kalau ID-nya gagal terbaca saat scan awal.
async function findCaseIndex(pg, { caseId, caseText, suiteBounds }) {
  return pg.evaluate(
    ({ caseId, caseText, suiteBounds, sel }) => {
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

      const titleEls = Array.from(document.querySelectorAll(sel.caseTitleCell));
      for (let i = 0; i < titleEls.length; i++) {
        const titleEl = titleEls[i];
        const row = titleEl.parentElement;

        if (caseId) {
          // ID case unik di seluruh run -- gak butuh disaring per rentang
          // pixel suite sama sekali. Batas suite (suiteBounds) cuma perlu
          // buat fallback title-matching di bawah, yang judulnya memang
          // bisa collision antar suite berbeda. Row yang persis di dekat
          // batas atas/bawah suite sempat "hilang" gara-gara posisi
          // pixel-nya bergeser dikit antar render (misal abis reload) dan
          // jadi kelempar keluar rentang cache -- padahal ID-nya sendiri
          // sudah cukup buat memastikan ini row yang benar.
          const idEl = row?.querySelector(sel.caseIdCell);
          const rowId = idEl ? idEl.textContent.trim() : null;
          if (rowId === caseId) return i;
        } else {
          const top = getAbsoluteTop(titleEl);
          if (top == null || top <= suiteBounds.top || top >= suiteBounds.boundaryTop) continue;
          const link = titleEl.querySelector(sel.caseTitleLink);
          const text = link ? link.textContent.trim() : '';
          if (text === caseText) return i;
        }
      }
      return -1;
    },
    { caseId, caseText, suiteBounds, sel: SELECTORS }
  );
}

// Mencari row yang cocok DAN mengkliknya dalam satu eksekusi DOM (bukan
// dua langkah "cari index lewat evaluate() lalu klik lewat locator.nth()
// terpisah"). Dua langkah terpisah itu terbukti rawan salah klik: list ini
// virtualized, row-nya di-recycle berdasarkan posisi layar bukan
// berdasarkan data case. Di jeda antara evaluate() menemukan index dan
// locator.nth(index).click() benar-benar jalan (ada round-trip Playwright
// + waitFor visible di antaranya), row di posisi itu bisa saja sudah
// ditempati case lain -- hasilnya script mengklik case yang salah tanpa
// error sama sekali (baru ketahuan belakangan lewat gejala tidak
// langsung, misal step count kebetulan sama sehingga validasi lain juga
// lolos). Dengan mencocokkan dan langsung .click() di dalam evaluate yang
// sama, tidak ada jeda buat row-nya berubah di antara keduanya.
async function clickMatchingCaseRow(pg, { caseId, caseText, suiteBounds }) {
  return pg.evaluate(
    ({ caseId, caseText, suiteBounds, sel }) => {
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

      const titleEls = Array.from(document.querySelectorAll(sel.caseTitleCell));
      for (const titleEl of titleEls) {
        const row = titleEl.parentElement;
        let matched;

        if (caseId) {
          const idEl = row?.querySelector(sel.caseIdCell);
          const rowId = idEl ? idEl.textContent.trim() : null;
          matched = rowId === caseId;
        } else {
          const top = getAbsoluteTop(titleEl);
          if (top == null || top <= suiteBounds.top || top >= suiteBounds.boundaryTop) continue;
          const link = titleEl.querySelector(sel.caseTitleLink);
          const text = link ? link.textContent.trim() : '';
          matched = text === caseText;
        }

        if (matched) {
          const link = titleEl.querySelector(sel.caseTitleLink);
          if (!link) return false;
          link.click();
          return true;
        }
      }
      return false;
    },
    { caseId, caseText, suiteBounds, sel: SELECTORS }
  );
}

// Membuka case di panel list. Kalau posisi pixel-nya sudah diketahui dari
// scanSuite (positions), langsung loncat scroll ke situ -- jauh lebih
// cepat & reliable daripada mencari incremental dari atas, karena tidak
// bergantung "kebetulan ketangkep" pas row-nya sempat ke-render selama
// scroll.
//
// Kalau loncatan itu belum berhasil (row-nya sempat belum ke-render pas
// dicek, atau posisinya memang belum diketahui), fallback-nya BUKAN
// scroll dari paling atas seluruh run seperti sebelumnya -- itu terbukti
// gagal untuk suite yang rentang pixel-nya sempit (sedikit case): step
// scroll yang kasar relatif terhadap tinggi suite bisa melompati seluruh
// suite dalam satu langkah tanpa pernah "kecek" pas posisinya pas di
// situ. Fallback-nya loncat dulu ke AWAL suite (posisinya sudah pasti
// dari scan), baru scroll HALUS dan dibatasi cuma sampai batas akhir
// suite ini saja -- rentang pencariannya jauh lebih sempit jadi jauh
// lebih kecil kemungkinan row-nya kelewat.
//
// Seluruh proses (bukan cuma klik-nya) diulang tiap retry -- list-nya
// kadang re-render di tengah jalan sehingga row yang tadinya ketemu bisa
// "detached from DOM" pas mau diklik.
async function openCase(pg, { caseId, caseText, suite }) {
  const label = caseId ? `case ID ${caseId}` : `case "${caseText}"`;
  const knownTop = suite.positions?.get(caseId ?? caseText);

  return retry(`buka ${label}`, RETRY_ATTEMPTS, async () => {
    const filterInput = pg.getByPlaceholder(SELECTORS.searchPlaceholder);
    await filterInput.fill('');
    await pg.locator(SELECTORS.caseTitleCell).first().waitFor({ state: 'attached', timeout: TIMING.elementAttachTimeoutMs });

    const scrollContainer = pg.locator(SELECTORS.scrollContainer).first();
    const hasScrollContainer = (await scrollContainer.count()) > 0;
    const find = () => findCaseIndex(pg, { caseId, caseText, suiteBounds: suite.bounds });

    let index = -1;

    if (hasScrollContainer && knownTop != null) {
      await scrollContainer.evaluate((el, { top, offsetRatio }) => {
        el.scrollTop = Math.max(0, top - el.clientHeight * offsetRatio);
      }, { top: knownTop, offsetRatio: TIMING.openCaseJumpOffsetRatio });
      // Dicoba beberapa kali DI POSISI YANG SAMA (bukan scroll lagi) --
      // row-nya kadang baru selesai ke-render sesaat setelah loncat,
      // apalagi tepat setelah halaman di-reload.
      for (let i = 0; i < TIMING.openCaseJumpRetries && index === -1; i++) {
        await pg.waitForTimeout(TIMING.openCaseJumpRetryDelayMs);
        index = await find();
      }
    }

    if (index === -1 && hasScrollContainer) {
      await scrollContainer.evaluate((el, top) => { el.scrollTop = top; }, suite.bounds.top);
      await pg.waitForTimeout(TIMING.openCaseFallbackScrollDelayMs);
      index = await find();
      if (index === -1) {
        index = await scrollSearch(pg, scrollContainer, find, {
          direction: 1,
          stepRatio: TIMING.openCaseFallbackStepRatio,
          maxScrollSteps: TIMING.openCaseFallbackMaxScrollSteps,
          stopAtTop: suite.bounds.boundaryTop,
        });
      }
    }

    if (index === -1) {
      throw new Error(`${label} tidak ditemukan setelah scroll ke seluruh list`);
    }

    // `index` di atas cuma dipakai buat tahu KAPAN berhenti scroll -- klik
    // sebenarnya pakai clickMatchingCaseRow, yang mencocokkan ulang row
    // dari awal dan langsung mengkliknya di eksekusi DOM yang sama supaya
    // tidak ada jeda buat row-nya ter-recycle jadi case lain (lihat
    // komentar di clickMatchingCaseRow).
    const clicked = await clickMatchingCaseRow(pg, { caseId, caseText, suiteBounds: suite.bounds });
    if (!clicked) {
      throw new Error(`${label} sempat ketemu saat scroll tapi hilang lagi tepat sebelum diklik (row ter-recycle) -- dicoba ulang`);
    }
  });
}

// Scroll bertahap ke satu arah sambil terus mencoba `find` di tiap
// pemberhentian, sampai ketemu atau mentok ujung list. Jeda antar step
// sengaja disamakan dengan scanSuite (700ms, bukan 400ms)
// -- di suite yang lebih besar (banyak row), jeda yang lebih pendek
// terbukti bikin row yang baru selesai di-render kelewat kecek sebelum
// benar-benar termuat.
async function scrollSearch(
  pg,
  scrollContainer,
  find,
  {
    direction,
    stepRatio = TIMING.scrollSearchDefaultStepRatio,
    maxScrollSteps = TIMING.scrollSearchDefaultMaxScrollSteps,
    stopAtTop,
  }
) {
  for (let i = 0; i < maxScrollSteps; i++) {
    const atEdge = await scrollContainer.evaluate(
      (el, dir) => (dir > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 5 : el.scrollTop <= 0),
      direction
    );
    if (atEdge) return -1;
    if (stopAtTop != null) {
      const passedStop = await scrollContainer.evaluate((el, top) => el.scrollTop > top, stopAtTop);
      if (passedStop) return -1;
    }
    // evaluate() cuma menerima SATU arg tambahan (bukan berapa pun
    // positional args) -- direction & stepRatio harus dibungkus jadi satu
    // objek, bukan dioper sebagai dua argumen terpisah seperti sebelumnya
    // (itu bikin stepRatio selalu undefined di sisi browser -> NaN ->
    // scrollTop diam-diam tidak pernah beranjak, karena assignment ke
    // NaN diabaikan browser sesuai spesifikasi DOM).
    await scrollContainer.evaluate((el, { dir, ratio }) => {
      el.scrollTop += dir * Math.round(el.clientHeight * ratio);
    }, { dir: direction, ratio: stepRatio });
    await pg.waitForTimeout(TIMING.scrollStepDelayMs);
    const found = await find();
    if (found !== -1) return found;
  }
  return -1;
}

// Panel case di suite ini di-virtualize (row di luar viewport tidak
// dirender ke DOM), jadi untuk menemukan semua case (bukan cuma yang
// kebetulan visible) kita perlu scroll bertahap sambil mengumpulkan
// title+status tiap kali, dedup, lalu berhenti begitu scrollTop sudah
// mentok.
//
// Selain daftar case Untested, batas pixel suite (top & boundaryTop) yang
// dihitung di sini juga dikembalikan -- dipakai lagi nanti oleh
// findCaseIndex supaya pencarian case per satu-satu tidak perlu menebak
// suite lewat header yang kebetulan masih ke-render (lihat komentar di
// findCaseIndex untuk alasannya).
async function scanSuite(pg, suiteText) {
  // Search box sengaja dikosongkan, bukan diisi nama suite. Search "by
  // all fields" Qase terbukti tidak mencakup semua case yang tergabung di
  // suite ini -- sejumlah case konsisten tidak muncul di hasil filter
  // walau secara visual jelas ada di bawah suite header yang sama. Jadi
  // list-nya di-scroll penuh tanpa filter, dan cakupan suite ditentukan
  // lewat posisi suite header (top pixel) seperti di bawah.
  const filterInput = pg.getByPlaceholder(SELECTORS.searchPlaceholder);
  await filterInput.fill('');
  await pg.locator(SELECTORS.caseTitleCell).first().waitFor({ state: 'attached', timeout: TIMING.elementAttachTimeoutMs });

  const scrollContainer = pg.locator(SELECTORS.scrollContainer).first();
  await scrollContainer.waitFor({ state: 'attached', timeout: TIMING.elementAttachTimeoutMs });

  const collected = new Map(); // key -> { title, status, top, caseId }
  const suiteHeaderTops = new Map(); // nama suite -> top

  // Tuning timing scroll (overlap, jumlah stable-read, jeda) sudah dicoba
  // beberapa kali dan tetap ada row yang kelewat di tengah suite.
  // Daripada terus menebak angka yang pas, list-nya di-scroll dari atas
  // ke bawah dua kali penuh dan hasilnya di-union ke Map yang sama -- row
  // yang kelewat di pass pertama kemungkinan besar tertangkap di pass
  // kedua.
  const scanPasses = TIMING.scanPasses;
  for (let pass = 1; pass <= scanPasses; pass++) {
    await scrollContainer.evaluate((el) => { el.scrollTop = 0; });
    await pg.waitForTimeout(TIMING.scanResetDelayMs);

    let lastScrollTop = -1;
    let stableReads = 0;
    const maxScrollSteps = TIMING.scanMaxScrollSteps;
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

          // Kolom "ID" yang tampil di tabel adalah identifier per case
          // yang stabil (beda dengan top, yang bisa jitter, atau judul,
          // yang bisa collision antar case). Coba pola aria-labelledby
          // dulu (konsisten dengan title_/status_), fallback ke span
          // angka murni di dalam row kalau polanya tidak ada.
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
        // Key-nya caseId kalau berhasil dibaca (paling reliable),
        // fallback ke judul+top kalau ekstraksinya gagal untuk row ini saja.
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
        if (stableReads >= TIMING.scanStableReads) break;
      } else {
        stableReads = 0;
      }
      lastScrollTop = scrollInfo.scrollTop;
      await scrollContainer.evaluate((el, ratio) => {
        el.scrollTop += Math.round(el.clientHeight * ratio);
      }, TIMING.scanScrollRatio);
      await pg.waitForTimeout(TIMING.scrollStepDelayMs);
    }
    console.log(`Scan pass ${pass}/${scanPasses} selesai, ${collected.size} judul terkumpul sejauh ini`);
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
  console.log(`Suite "${suiteText}" (top=${targetTop}, boundary=${boundaryTop}): ${inRange.length} case dalam rentang`);

  // Diurutkan berdasarkan posisi visual (top pixel, ascending). Catatan:
  // atribut aria-labelledby ("title_N") bukan id case yang unik per row --
  // nilainya sama untuk semua row (kemungkinan itu id elemen header
  // kolom "Title"). ID case yang genuinely unik ada di kolom tabel
  // (caseId di atas), tapi urutan tetap dipakai dari top pixel karena itu
  // mencerminkan urutan dokumen aslinya.
  //
  // Dedup by caseId kalau ada, fallback by title -- di dalam satu suite
  // keduanya seharusnya unik. Kalau ada yang muncul dua kali di sini, itu
  // row fisik yang sama terukur beda tipis antar pass, bukan case yang
  // benar-benar dobel.
  const seenKeys = new Set();
  const untested = inRange
    .filter((info) => info.status === 'Untested')
    .sort((a, b) => a.top - b.top)
    .map((info) => ({ title: info.title, caseId: info.caseId }))
    .filter((c) => {
      const key = c.caseId ?? c.title;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

  // Posisi pixel (top) tiap case dalam suite ini -- dipakai lagi nanti
  // oleh openCase supaya bisa loncat LANGSUNG ke posisi yang benar saat
  // membuka satu case, bukan mencari incremental dari atas tiap kali.
  // Pencarian incremental itu sendiri kadang kelewat row yang sempat
  // tidak ke-render pas discroll cepat (virtualisasi Qase) -- sedangkan
  // scan di atas jauh lebih reliable karena discroll penuh 2x sambil terus
  // mengumpulkan, bukan berhenti begitu ketemu.
  const positions = new Map();
  for (const info of inRange) {
    positions.set(info.caseId ?? info.title, info.top);
  }

  return { untested, bounds: { top: targetTop, boundaryTop }, positions };
}

// Membaca urutan step dari case yang sedang terbuka. Teks step-nya
// diambil dari span[data-lexical-text] -- bukan textContent polos di
// stepHeader, karena itu ikut membawa nomor badge-nya juga (jadi nempel
// jadi "1Masukkan nama bank..." alih-alih "Masukkan nama bank..." saja).
async function getOrderedStepTexts(pg) {
  // Drawer case butuh waktu untuk merender StepsList-nya setelah diklik --
  // tanpa nunggu, query di bawah bisa berjalan saat masih 0 elemen.
  await pg.locator(SELECTORS.stepHeader).first().waitFor({ state: 'attached', timeout: TIMING.elementAttachTimeoutMs });

  // Drawer case sebelumnya bisa saja masih transisi keluar (fade-out step
  // lama) tepat saat drawer case baru mulai merender, sehingga jumlah
  // step yang terbaca lebih banyak dari yang sebenarnya ada. Tunggu
  // jumlah step stabil dulu sebelum diambil.
  await waitForStableCount(() => pg.locator(SELECTORS.stepHeader).count(), {
    intervalMs: TIMING.stepListStableIntervalMs,
    requiredStableReads: TIMING.stepListStableReads,
    maxIterations: TIMING.stepListStableMaxIterations,
  });

  // Urutan diambil langsung dari urutan DOM (querySelectorAll otomatis
  // mengembalikan elemen sesuai urutan tampil), bukan disortir ulang
  // berdasarkan atribut title="N" -- Qase tidak selalu menyetel atribut
  // itu (step tunggal title-nya null), dan sorting terhadap nilai yang
  // kadang NaN membuat urutan tidak reliable.
  return pg.locator(SELECTORS.stepHeader).evaluateAll((headers) =>
    headers.map((h) => h.querySelector('span[data-lexical-text="true"]')?.textContent?.trim() ?? '')
  );
}

// Mengecek apakah drawer yang sedang tampil benar-benar case yang
// diharapkan (lewat ID "MKR03-<id>" yang tampil di sidebar drawer,
// bukan cuma dipercaya begitu saja dari hasil openCase di awal).
// Ternyata drawer bisa diam-diam "kembali" ke case sebelumnya di
// tengah proses baca step (root cause timeout getByText yang
// membingungkan di collectEvidenceForStep -- step 1/2 sempat sukses
// karena drawer masih benar saat itu, baru step 3 nyasar begitu drawer-nya
// balik ke case lain). null berarti tidak bisa dipastikan (caseId tidak
// ada), true/false hasil pengecekan sesungguhnya.
//
// Pencarian teks-nya WAJIB dikecualikan dari scrollContainer (panel list
// case di kiri) -- list itu virtualized tapi row case yang lagi diproses
// (termasuk ID-nya) tetap ke-render di sana selama case itu ada dalam
// jangkauan scroll saat ini, terlepas dari case mana yang drawer-nya lagi
// dibuka. Percobaan pertama fungsi ini (tanpa pengecualian ini) selalu
// bernilai true walau drawer sudah nyasar ke case lain, persis karena ID
// yang dicari kebetulan masih nongol di row list kiri.
async function isDrawerShowingCase(pg, caseId) {
  if (!caseId) return null;
  return pg.evaluate(
    ({ caseId, scrollContainerSel }) => {
      const scrollEl = document.querySelector(scrollContainerSel);
      const idPattern = new RegExp(`(?<!\\d)${caseId}(?!\\d)`);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (scrollEl && scrollEl.contains(node)) continue;
        if (node.textContent && idPattern.test(node.textContent)) return true;
      }
      return false;
    },
    { caseId, scrollContainerSel: SELECTORS.scrollContainer }
  );
}

// Melakukan klik-expand tiap step di SIT (step di sana collapsed by
// default) dan mengambil evidence + teks Expected result dari
// masing-masing step secara terpisah -- bukan cuma step terakhir, karena
// satu case bisa punya evidence tersebar di beberapa step sekaligus.
// Mengembalikan array sepanjang stepTexts; tiap elemen berupa
// { evidencePaths, expectedResultText } (evidencePaths bisa kosong kalau
// step-nya memang tidak ada evidence, expectedResultText dipakai nanti
// buat ngisi Actual result di UAT -- lihat markStepsPassed).
async function collectEvidencePerStep(page, caseText, caseId, suite, stepTexts) {
  const stepEvidence = [];
  for (let i = 0; i < stepTexts.length; i++) {
    const stepResult = await collectEvidenceForStep(page, caseText, caseId, suite, stepTexts[i], i + 1);
    stepEvidence.push(stepResult);
  }
  return stepEvidence;
}

// Mencari data step `stepNumber`: URL evidence dari blok "Actual result"
// DAN teks dari blok "Expected result", dalam satu evaluate yang sama
// (range step-nya cuma perlu dihitung sekali buat keduanya). Sebelumnya
// fungsi ini (findEvidenceUrlsForStep) cuma menjangkarkan pencarian ke
// teks "Actual result" persis "As Expected" (exact match) -- ternyata
// gagal untuk case yang actual result-nya ditulis lebih panjang dari itu
// (mis. "As Expected, system block input value non numeric"), karena
// exact match menolak teks tambahan apa pun. Isi Actual result
// seharusnya tidak relevan sama sekali buat menemukan evidence-nya, jadi
// dicari langsung lewat STRUKTUR field-nya: tiap step render beberapa
// blok StepDataField (Input data/Expected result/Actual result),
// masing-masing berupa <h4> label + isi. Evidence selalu ada di blok
// yang label <h4>-nya persis "Actual result", terlepas apa pun isi
// teksnya -- teknik yang sama dipakai lagi di sini buat blok "Expected
// result", supaya teksnya bisa dipakai ngisi Actual result di UAT nanti
// (lihat markStepsPassed) alih-alih nilai statis.
async function findStepFieldsForStep(page, stepNumber) {
  return page.evaluate(
    ({ stepNumber, stepHeaderSelector, fieldSelector, fieldHeaderSelector, actualResultLabel, expectedResultLabel, galleryClass }) => {
      const headers = Array.from(document.querySelectorAll(stepHeaderSelector));
      let startEl = headers.find((h) => h.getAttribute('title') === String(stepNumber));
      if (!startEl) startEl = headers[stepNumber - 1]; // fallback: step tunggal tidak selalu punya atribut title
      if (!startEl) return { evidenceUrls: [], expectedResultText: '' };
      const endEl = headers[headers.indexOf(startEl) + 1] ?? null;

      function isInStepRange(el) {
        const atOrAfterStart = el === startEl || !!(startEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const beforeEnd = !endEl || (el !== endEl && !!(el.compareDocumentPosition(endEl) & Node.DOCUMENT_POSITION_FOLLOWING));
        return atOrAfterStart && beforeEnd;
      }

      const fieldBlocks = Array.from(document.querySelectorAll(fieldSelector)).filter(isInStepRange);

      function findFieldBlock(label) {
        return fieldBlocks.find((block) => {
          const header = block.querySelector(fieldHeaderSelector);
          return header && header.textContent.trim() === label;
        });
      }

      let evidenceUrls = [];
      const actualResultBlock = findFieldBlock(actualResultLabel);
      if (actualResultBlock) {
        const galleryEl = actualResultBlock.querySelector(`.${galleryClass}`);
        if (galleryEl) evidenceUrls = Array.from(galleryEl.querySelectorAll('img')).map((img) => img.src);
      }

      // Blok Expected result (dan Input data) selalu contenteditable
      // (true atau false tergantung field-nya) -- dipakai sebagai
      // anchor isi teksnya supaya label <h4>-nya sendiri tidak ikut
      // kebawa ke dalam textContent.
      let expectedResultText = '';
      const expectedResultBlock = findFieldBlock(expectedResultLabel);
      if (expectedResultBlock) {
        const contentEl = expectedResultBlock.querySelector('[contenteditable]');
        expectedResultText = contentEl ? contentEl.textContent.trim() : '';
      }

      return { evidenceUrls, expectedResultText };
    },
    {
      stepNumber,
      stepHeaderSelector: SELECTORS.stepHeader,
      fieldSelector: `.${SELECTORS.stepFieldClass}`,
      fieldHeaderSelector: SELECTORS.stepFieldHeaderClass,
      actualResultLabel: TEXT.actualResultFieldLabel,
      expectedResultLabel: TEXT.expectedResultFieldLabel,
      galleryClass: SELECTORS.evidenceGalleryClass,
    }
  );
}

// Membungkus collectEvidenceForStepOnce dengan pemulihan otomatis: kalau
// ketahuan drawer-nya nyasar ke case lain (DrawerMismatchError), case-nya
// dibuka ulang lalu step yang sama dicoba lagi -- bukan langsung
// menyerahkan seluruh run. Aman dilakukan karena identitas drawer selalu
// dicek ulang lagi dari nol di percobaan berikutnya (lewat
// collectEvidenceForStepOnce), jadi tidak mungkin evidence ke-attach ke
// case yang salah walau di-retry. Kegagalan lain (download gagal, dst)
// TETAP langsung dilempar tanpa retry -- cuma mismatch case yang dianggap
// aman dipulihkan otomatis.
async function collectEvidenceForStep(page, caseText, caseId, suite, stepText, stepNumber) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await collectEvidenceForStepOnce(page, caseText, caseId, stepText, stepNumber);
    } catch (err) {
      if (!(err instanceof DrawerMismatchError) || attempt > DRAWER_RECOVERY_ATTEMPTS) throw err;
      console.log(
        `Drawer SIT nyasar dari case "${caseText}" pas step ${stepNumber} -- buka ulang case & coba lagi (percobaan ${attempt}/${DRAWER_RECOVERY_ATTEMPTS}).`
      );
      await openCase(page, { caseId, caseText, suite });
      // Step list butuh waktu render ulang setelah reopen -- tunggu
      // jumlahnya stabil dulu sebelum step ini dicoba lagi, dengan
      // parameter yang SAMA seperti yang dilakukan getOrderedStepTexts
      // sesaat setelah case dibuka (lihat TIMING.stepListStable*).
      await waitForStableCount(() => page.locator(SELECTORS.stepHeader).count(), {
        intervalMs: TIMING.stepListStableIntervalMs,
        requiredStableReads: TIMING.stepListStableReads,
        maxIterations: TIMING.stepListStableMaxIterations,
      });
    }
  }
}

// Mengambil evidence dari satu step SIT. Step tidak selalu punya evidence
// -- case validasi kadang cuma dikonfirmasi lewat teks "As Expected"
// tanpa screenshot, dan itu valid, bukan error, sehingga fungsi ini
// mengembalikan array kosong untuk kasus itu (bukan throw). Kegagalan
// setelah evidence-nya dipastikan ada (download gagal, dll) dianggap
// fatal lewat EvidenceIntegrityError, bukan ditelan diam-diam seperti
// kasus "evidence memang tidak ada".
async function collectEvidenceForStepOnce(page, caseText, caseId, stepText, stepNumber) {
  const evidencePaths = [];
  let expectedResultText = '';

  // Dicek dulu SEBELUM klik, bukan cuma pas gagal -- kalau drawer sudah
  // nyasar ke case lain, klik di bawah pasti bakal timeout 30 detik dulu
  // (nyari teks yang memang tidak ada di halaman) sebelum ketahuan. Gagal
  // cepat di sini jauh lebih jelas & jauh lebih murah.
  const stillOnCase = await isDrawerShowingCase(page, caseId);
  if (stillOnCase === false) {
    await saveDebugScreenshot(page, `debug-sit-step${stepNumber}-wrong-case.png`);
    throw new DrawerMismatchError(
      `Drawer SIT tidak lagi menampilkan case "${caseText}" (ID ${caseId}) pas mau ambil evidence step ${stepNumber} -- drawer-nya kepindah/kereset ke case lain di tengah proses. Evidence tidak diambil supaya tidak salah lampir ke case yang keliru.`
    );
  }

  try {
    // Bukan literally klik-kanan "Save image as" -- itu dialog native
    // OS/Chrome yang tidak bisa disentuh Playwright. Yang dilakukan di
    // sini secara fungsional sama: fetch langsung URL gambarnya memakai
    // session yang aktif, lalu tulis ke disk.
    await page.getByText(stepText, { exact: false }).first().click();

    // networkidle di sini nyaris tidak pernah tercapai -- Qase punya
    // koneksi background yang jarang benar-benar diam -- jadi jeda
    // pendek yang jujur dipakai sebagai gantinya. Kepastian evidence
    // sudah selesai render tetap diverifikasi lewat polling di bawah.
    await page.waitForTimeout(TIMING.evidenceExpandDelayMs);

    // Kalau evidence-nya banyak, gambar berikutnya bisa masih menyusul
    // render-nya walau yang pertama sudah muncul -- tunggu jumlahnya
    // stabil dulu sebelum mulai fetch, biar semua evidence terambil.
    let evidenceUrls = [];
    let lastCount = -1;
    let stableReads = 0;
    for (let i = 0; i < TIMING.evidencePollMaxIterations; i++) {
      const fields = await findStepFieldsForStep(page, stepNumber);
      evidenceUrls = fields.evidenceUrls;
      expectedResultText = fields.expectedResultText;
      if (evidenceUrls.length === lastCount) {
        stableReads++;
        if (stableReads >= TIMING.evidencePollStableReads) break;
      } else {
        stableReads = 0;
        lastCount = evidenceUrls.length;
      }
      await page.waitForTimeout(TIMING.evidencePollIntervalMs);
    }

    if (evidenceUrls.length === 0) {
      console.log(`Case "${caseText}" step ${stepNumber}: tidak ada evidence -- dilewati tanpa lampiran.`);
      return { evidencePaths, expectedResultText };
    }

    fs.mkdirSync(EVIDENCE_SIT_DIR, { recursive: true });
    for (let i = 0; i < evidenceUrls.length; i++) {
      const imageUrl = evidenceUrls[i];
      if (!imageUrl) {
        throw new EvidenceIntegrityError(
          `Evidence gambar ke-${i + 1} step ${stepNumber} untuk case "${caseText}" tidak punya atribut src -- tidak bisa didownload dari SIT.`
        );
      }
      // Evidence-nya sudah dipastikan ada -- download harus sukses (HTTP
      // 2xx). Gagal di titik ini artinya ada masalah teknis nyata, bukan
      // "memang tidak ada evidence", makanya diperlakukan fatal.
      const response = await page.request.get(imageUrl);
      if (!response.ok()) {
        throw new EvidenceIntegrityError(
          `Gagal download evidence ke-${i + 1} step ${stepNumber} untuk case "${caseText}" dari SIT (HTTP ${response.status()}). URL: ${imageUrl}`
        );
      }
      const buffer = await response.body();

      // Masking (kalau aktif) dilakukan DI SINI, sebelum file pernah
      // ditulis ke disk -- byte mentah/asli tidak pernah menyentuh
      // EVIDENCE_SIT_DIR sama sekali. Kegagalan OCR di titik ini
      // dilempar sebagai EvidenceMaskingError, ditangkap sefatal
      // EvidenceIntegrityError di bawah (lihat percabangan di akhir file).
      const maskedBuffer = MASKING_ENABLED
        ? (await maskEvidenceImage(buffer, { sourceLabel: `case "${caseText}" step ${stepNumber} gambar ke-${i + 1}` })).maskedBuffer
        : buffer;

      const filename = nextAvailableFilename(EVIDENCE_SIT_DIR, 'image', '.png');
      const sitEvidencePath = path.join(EVIDENCE_SIT_DIR, filename);
      fs.writeFileSync(sitEvidencePath, maskedBuffer);
      evidencePaths.push(sitEvidencePath);
      console.log(`Evidence tersimpan (step ${stepNumber}): ${sitEvidencePath}`);
    }
  } catch (err) {
    // EvidenceMaskingError diperlakukan sama seperti EvidenceIntegrityError
    // (dilempar apa adanya, tanpa dibungkus ulang) -- kegagalan OCR tidak
    // ada hubungannya dengan state drawer SIT, jadi pengecekan
    // isDrawerShowingCase di bawah cuma bikin pesan errornya membingungkan.
    if (err instanceof EvidenceIntegrityError || err instanceof EvidenceMaskingError) throw err;
    // Sampai titik ini, "tidak ada evidence" sudah ditangani lewat return
    // di atas -- exception yang nyasar ke sini berarti ada kegagalan
    // teknis (klik gagal, evaluate gagal, dll), bukan sekadar step yang
    // memang kosong, jadi diperlakukan fatal juga.
    await saveDebugScreenshot(page, `debug-sit-step${stepNumber}-error.png`);
    // Drawer-nya bisa saja nyasar ke case lain PAS SEDANG nunggu klik
    // (bukan cuma sebelum klik dimulai, yang sudah ditangkap di guard
    // atas) -- dicek ulang di sini biar error timeout yang membingungkan
    // tetap menyebut kemungkinan penyebab sesungguhnya secara eksplisit.
    const stillOnCase = await isDrawerShowingCase(page, caseId);
    if (stillOnCase === false) {
      throw new DrawerMismatchError(
        `Gagal mengambil evidence step ${stepNumber} untuk case "${caseText}": ${err.message}. Drawer SIT sudah tidak lagi menampilkan case ini (ID ${caseId}) -- kemungkinan besar berpindah/kereset ke case lain di tengah proses baca step ini.`
      );
    }
    throw new EvidenceIntegrityError(
      `Gagal mengambil evidence step ${stepNumber} untuk case "${caseText}": ${err.message}`
    );
  }

  return { evidencePaths, expectedResultText };
}

// Klik "Assign to me" kalau tombolnya masih aktif (disabled berarti case
// ini sudah pernah di-assign/dieksekusi sebelumnya, jadi dilewati supaya
// script tetap idempotent).
//
// Ada dua elemen "Assign to me" di halaman ini: satu di toolbar
// bulk-action (list kiri, di sebelah Assign/Unassign, disabled kalau
// tidak ada case yang dicentang), satu lagi di drawer case (yang dituju
// di sini). Di-scope ke assignToMeScope (container toolbar drawer) supaya
// tidak salah ambil yang bulk-action-nya -- .first()/.last() saja gampang
// meleset karena urutan DOM-nya tidak selalu sama dengan urutan visual.
async function assignToMeIfNeeded(uatPage, caseText, caseId, suite) {
  const assignButton = uatPage.locator(SELECTORS.assignToMeScope).getByRole('button', { name: TEXT.assignToMeLabel });
  const isAssignable = await assignButton.isEnabled().catch(() => false);
  if (!isAssignable) return;

  await assignButton.click();

  // Tunggu request assign-nya benar-benar terkirim dulu -- kalau langsung
  // reload, request-nya bisa ke-cancel di tengah jalan sebelum sempat
  // diproses server, hasilnya malah balik lagi ke Unassigned setelah
  // reload. networkidle tidak pernah tercapai di app ini (koneksi
  // background-nya jarang benar-benar diam), jadi jeda pendek yang jujur
  // dipakai sebagai gantinya.
  await uatPage.waitForTimeout(TIMING.assignRequestSettleMs);

  // Tombol Passed/Failed/Blocked/Skipped per step baru muncul setelah
  // reload -- tidak reactive terhadap assignment barusan, jadi reload
  // manual lalu buka lagi case-nya supaya drawer merender ulang dengan
  // data segar.
  await uatPage.reload();
  await uatPage.waitForLoadState();

  // Reload itu operasi berat -- panel case yang virtualized butuh waktu
  // lebih buat "settle" (mengukur scrollHeight, dst) dibanding sekadar
  // scroll biasa di halaman yang sudah stabil. Loncat scroll ke posisi
  // jauh sebelum ini beres terbukti bikin openCase salah baca posisi
  // tepat setelah reload. withFailureScreenshot juga dipasang di sini
  // (sebelumnya tidak) supaya kalau reopen ini tetap gagal, ada bukti
  // visual kondisi halamannya -- sebelumnya kegagalan di titik ini lolos
  // tanpa screenshot sama sekali, bikin susah didiagnosis.
  await uatPage.waitForTimeout(TIMING.assignReloadSettleMs);
  await withFailureScreenshot(uatPage, 'debug-uat-reopen-after-assign.png', () =>
    openCase(uatPage, { caseId, caseText, suite })
  );
}

// Validasi jumlah step SIT vs UAT sebelum mulai eksekusi step.
// getOrderedStepTexts di SIT bisa menangkap step tambahan yang sebenarnya
// tidak dirender di UAT -- kalau dibiarkan, loop di markStepsPassed akan
// mencoba klik step yang tidak ada dan timeout 30 detik per step yang
// meleset. Gagal cepat dan jelas di sini jauh lebih baik.
async function validateStepCountMatches(uatPage, caseText, expectedStepCount) {
  // .count() adalah snapshot instan -- kalau dipanggil tepat setelah
  // drawer baru dibuka/reload dan step list-nya belum sempat kerender,
  // hasilnya 0 walau step-nya sebenarnya ada. Tunggu jumlahnya stabil
  // dulu sebelum dibandingkan dengan ekspektasi dari SIT.
  const actualStepCount = await waitForStableCount(() => uatPage.locator(SELECTORS.stepHeader).count(), {
    intervalMs: TIMING.stepCountStableIntervalMs,
    requiredStableReads: TIMING.stepCountStableReads,
    maxIterations: TIMING.stepCountStableMaxIterations,
  });
  if (actualStepCount === expectedStepCount) return;

  await saveDebugScreenshot(uatPage, 'debug-uat-step-count-mismatch.png');
  throw new Error(
    `Jumlah step tidak cocok untuk case "${caseText}" -- SIT terbaca ${expectedStepCount} step, tapi UAT cuma ada ${actualStepCount} step yang dirender.`
  );
}

// Dump langsung dari DOM asli (bukan menebak dari HTML yang ditempel
// manual) supaya query-nya mencerminkan persis apa yang ada saat
// kegagalan terjadi.
async function logStepDebugInfo(uatPage, stepNumber) {
  const debugInfo = await uatPage.evaluate(
    ({ n, sel, passedLabel }) => {
      const headers = Array.from(document.querySelectorAll(sel.stepHeader)).map((el) => ({
        title: el.getAttribute('title'),
        text: el.textContent.slice(0, 40),
      }));
      const passedButtons = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === passedLabel
      );
      const target = document.querySelector(`${sel.stepHeader}[title="${n}"]`);
      return {
        totalStepHeaders: headers.length,
        headers,
        totalPassedButtons: passedButtons.length,
        passedButtonsClass: passedButtons.map((b) => b.className),
        targetFound: !!target,
        targetParentHTML: target ? target.parentElement.outerHTML.slice(0, 2000) : null,
      };
    },
    { n: stepNumber, sel: SELECTORS, passedLabel: TEXT.passedLabel }
  );
  console.log('DOM info step:', JSON.stringify(debugInfo, null, 2));
}

// Melampirkan semua evidence yang baru disimpan dari SIT ke step terakhir
// di UAT. Attachment lama (kalau ada dari run sebelumnya) dihapus dulu
// supaya tidak menumpuk -- direplace, bukan ditambah terus tiap run.
async function attachEvidenceToStep(stepBody, uatPage, sitEvidencePaths, caseText, stepNumber) {
  // Loop terus dari .first() -- begitu satu terhapus, sisanya otomatis
  // bergeser jadi .first() yang baru.
  let existingAttachment = stepBody.locator('img').first();
  while (await existingAttachment.isVisible().catch(() => false)) {
    await existingAttachment.hover();
    const removeButton = stepBody.getByRole('button', { name: /remove|delete|hapus/i }).first();
    if (!(await removeButton.isVisible().catch(() => false))) break;
    await removeButton.click();
    existingAttachment = stepBody.locator('img').first();
  }

  // Bukan literally membuka dialog native "Open" -- itu di luar jangkauan
  // Playwright. Yang dipakai adalah setInputFiles() langsung ke <input
  // type="file"> di balik tombol upload, hasilnya sama -- array path
  // otomatis diperlakukan sebagai multi-file select.
  //
  // Pakai .last() karena input file dari klik sebelumnya kadang tidak
  // ter-cleanup dari DOM, sehingga bisa ada lebih dari satu <input
  // type="file"> yang tersisa; yang relevan dengan tombol "Add
  // attachment" yang baru diklik adalah yang paling terakhir ditambahkan
  // ke DOM.
  await stepBody.getByRole('button', { name: TEXT.addAttachmentLabel }).click();
  await uatPage.locator('input[type="file"]').last().setInputFiles(sitEvidencePaths);

  // setInputFiles() cuma memastikan file-nya "dipilih", bukan jaminan
  // upload-nya sukses (bisa gagal karena network/limit ukuran tanpa
  // Playwright tahu). Verifikasi sesungguhnya: tunggu jumlah <img> di
  // step body ini mencapai minimal sejumlah evidence yang di-upload.
  let uploadedCount = 0;
  const uploaded = await pollUntil(
    async () => {
      uploadedCount = await stepBody.locator('img').count();
      return uploadedCount >= sitEvidencePaths.length;
    },
    { intervalMs: TIMING.uploadPollIntervalMs, maxIterations: TIMING.uploadPollMaxIterations }
  );

  if (!uploaded) {
    await saveDebugScreenshot(uatPage, `debug-uat-upload-verify-${stepNumber}.png`);
    const bodyHtml = await stepBody.evaluate((el) => el.outerHTML.slice(-3000)).catch(() => '(gagal ambil HTML)');
    console.log('DOM stepBody setelah upload (potongan akhir):', bodyHtml);
    throw new EvidenceIntegrityError(
      `Upload evidence ke UAT untuk case "${caseText}" gagal diverifikasi -- ekspektasi minimal ${sitEvidencePaths.length} gambar terlampir, cuma terdeteksi ${uploadedCount}.`
    );
  }
}

// Menandai tiap step "Passed" dan mengisi "Actual result" dengan teks
// Expected result step yang bersangkutan (dibaca dari SIT lewat
// findStepFieldsForStep, lihat stepEvidence[i].expectedResultText) --
// supaya Actual result mencerminkan hasil aktual yang sama seperti yang
// diharapkan, bukan nilai statis. Fallback ke TEXT.actualResultValue
// kalau Expected result-nya kosong/tidak kebaca sama sekali. Step body
// tidak perlu di-expand -- begitu case ter-assign dengan benar, semua
// field (Input data/Expected result/tombol verdict) langsung tampil
// tanpa toggle apa pun.
//
// Step di-scope lewat atribut title="N" di step header supaya tidak
// salah sasaran ke step lain -- kecuali untuk case dengan satu step
// saja: Qase tidak menyetel atribut title="1" untuk step tunggal, jadi
// selector by-attribute tidak akan pernah cocok. Fallback ke posisi DOM
// (nth, 0-indexed) kalau selector by-attribute kosong.
async function markStepsPassed(uatPage, uatStepTexts, stepEvidence, caseText) {
  for (let i = 0; i < uatStepTexts.length; i++) {
    const stepNumber = i + 1;
    const { evidencePaths = [], expectedResultText = '' } = stepEvidence[i] ?? {};
    const stepHeaderByAttribute = uatPage.locator(`${SELECTORS.stepHeader}[title="${stepNumber}"]`);
    const stepHeader = (await stepHeaderByAttribute.count()) > 0
      ? stepHeaderByAttribute
      : uatPage.locator(SELECTORS.stepHeader).nth(stepNumber - 1);
    const stepBody = stepHeader.locator('xpath=..');

    // Step yang punya sub-step (mis. step "3" yang membungkus "3.1"/"3.2")
    // ke-render Qase sebagai CONTAINER murni -- tidak punya tombol verdict
    // atau field "Actual result" miliknya sendiri sama sekali, cuma
    // membungkus sub-step di dalamnya yang masing-masing PUNYA verdict
    // sendiri (dan diproses di posisi/index-nya sendiri di loop ini, lewat
    // atribut title "N.M" atau fallback posisi). Kalau stepBody container
    // ini di-query cari tombol Passed, hasilnya bukan 0 atau 1 (nempel ke
    // tombol Passed) tapi ke SEMUA tombol verdict sub-step di dalamnya --
    // makanya diklik langsung tanpa cek jumlah dulu bikin Playwright
    // menolak lewat "strict mode violation" (ambigu, tidak tahu yang mana
    // yang harus diklik). Step container ini dilewati total (bukan cuma
    // klik verdict-nya) -- SIT juga tidak pernah mendeteksi evidence di
    // step ini (tidak ada field "Actual result" di levelnya), jadi memang
    // tidak ada apa pun yang perlu ditandai/dilampirkan di sini.
    const passedButton = stepBody.locator(`button.${SELECTORS.stepVerdictButtonClass}`, { hasText: TEXT.passedLabel });
    const passedButtonCount = await passedButton.count();

    if (passedButtonCount > 1) {
      console.log(
        `Case "${caseText}" step ${stepNumber}: dilewati -- ini step container yang membungkus sub-step (tidak punya verdict/evidence sendiri), sub-step-nya ditandai terpisah di posisinya masing-masing.`
      );
      continue;
    }

    if (passedButtonCount === 0) {
      await saveDebugScreenshot(uatPage, `debug-uat-step${stepNumber}-no-verdict-button.png`);
      await logStepDebugInfo(uatPage, stepNumber);
      throw new Error(
        `Step ${stepNumber} case "${caseText}" tidak ketemu tombol verdict "Passed" sama sekali -- step-nya kemungkinan tidak ke-render dengan benar.`
      );
    }

    try {
      // getByRole name:'Passed' exact bermasalah karena tombol ini punya
      // <i class="fas fa-check">, dan Chromium ikut memasukkan konten
      // CSS ::before icon-nya ke accessible name (jadi bukan persis
      // "Passed" lagi). Pakai class yang dipakai bersama 4 tombol
      // per-step + hasText untuk cek textContent yang dirender.
      await passedButton.click();
    } catch (err) {
      await saveDebugScreenshot(uatPage, `debug-uat-step${stepNumber}.png`);
      await logStepDebugInfo(uatPage, stepNumber);
      throw err;
    }

    try {
      // "Actual result" adalah editor rich-text Lexical (div
      // contenteditable="true"), bukan <textarea>/<input> -- tidak ada
      // role ARIA "textbox" eksplisit sehingga getByRole('textbox') tidak
      // pernah cocok. Field read-only lain (Input data/Expected result)
      // memakai contenteditable="false", jadi selector ini sudah cukup spesifik.
      await stepBody.locator('[contenteditable="true"]').last().fill(expectedResultText || TEXT.actualResultValue);
    } catch (err) {
      await saveDebugScreenshot(uatPage, `debug-uat-step${stepNumber}-actualresult.png`);
      const bodyHtml = await stepBody.evaluate((el) => el.outerHTML.slice(-3000));
      console.log('DOM stepBody (potongan akhir):', bodyHtml);
      throw err;
    }

    if (evidencePaths.length > 0) {
      await attachEvidenceToStep(stepBody, uatPage, evidencePaths, caseText, stepNumber);
    }
  }
}

// Memproses 1 test case penuh: ambil evidence dari SIT, lalu tandai
// Passed dan lampirkan evidence yang sama di UAT. Step-nya dibaca
// otomatis dari SIT (identik dengan UAT, cuma beda run) sehingga tidak
// perlu di-hardcode.
async function processCase(page, uatPage, caseText, caseId, sitSuite, uatSuite) {
  // --- SIT: buka case, baca step, ambil evidence dari tiap step ---
  // Tab yang tampil di depan diikutkan pindah sesuai tahap yang sedang
  // berjalan, murni supaya kelihatan jelas automation-nya lagi ngapain --
  // tidak mempengaruhi page mana yang benar-benar dikendalikan di baliknya.
  await page.bringToFront();
  await withFailureScreenshot(page, 'debug-sit-page.png', () =>
    openCase(page, { caseId, caseText, suite: sitSuite })
  );

  const uatStepTexts = await getOrderedStepTexts(page);
  const stepEvidence = await collectEvidencePerStep(page, caseText, caseId, sitSuite, uatStepTexts);

  // --- UAT: buka case yang sama, assign, lalu eksekusi tiap step ---
  await uatPage.bringToFront();
  await withFailureScreenshot(uatPage, 'debug-uat-page.png', () =>
    openCase(uatPage, { caseId, caseText, suite: uatSuite })
  );

  await assignToMeIfNeeded(uatPage, caseText, caseId, uatSuite);
  await validateStepCountMatches(uatPage, caseText, uatStepTexts.length);
  await markStepsPassed(uatPage, uatStepTexts, stepEvidence, caseText);

  // Verdict keseluruhan case (beda dari verdict per-step) -- dibedakan
  // lewat class stepVerdictButtonClass yang dipakai bersama 4 tombol
  // per-step, sedangkan tombol verdict keseluruhan tidak memakainya.
  await uatPage
    .locator(`button.${SELECTORS.caseVerdictButtonClass}:not(.${SELECTORS.stepVerdictButtonClass})`, {
      hasText: TEXT.passedLabel,
    })
    .click();

  // Klik ini memicu request async ke server -- kalau case berikutnya
  // langsung diproses (isi search box, navigasi, dll), request yang
  // belum selesai bisa ke-cancel di tengah jalan (persis kejadian yang
  // sama di tombol "Assign to me"), dan statusnya diam-diam gak
  // kesimpan walau klik-nya sendiri "berhasil" secara Playwright.
  await uatPage.waitForTimeout(TIMING.caseVerdictSettleMs);

  // Klik doang bukan jaminan Qase beneran menyimpan perubahannya --
  // dibaca ulang statusnya dari panel list, bukan cuma dipercaya dari
  // hasil klik. Kalau ternyata masih belum Passed setelah ditunggu,
  // dianggap gagal (bukan diklaim sukses padahal tidak).
  await verifyCaseMarkedPassed(uatPage, caseText, caseId, uatSuite.bounds);

  const totalEvidenceCount = stepEvidence.reduce((sum, s) => sum + s.evidencePaths.length, 0);
  const stepsWithEvidence = stepEvidence.filter((s) => s.evidencePaths.length > 0).length;
  console.log(`Selesai case "${caseText}": ${totalEvidenceCount} evidence terlampir (tersebar di ${stepsWithEvidence} step) & UAT ditandai Passed di semua step.`);
}

// Membaca status case saat ini langsung dari panel list (bukan dari
// drawer), dengan teknik yang sama seperti findCaseIndex di openCase --
// dicocokkan lewat ID kalau tersedia (unik di seluruh run, gak perlu
// disaring per suite), fallback ke judul yang baru disaring lewat rentang
// pixel suite supaya tidak salah ambil case lain yang judulnya kebetulan
// sama.
async function readCaseStatus(pg, { caseId, caseText, suiteBounds }) {
  return pg.evaluate(
    ({ caseId, caseText, suiteBounds, sel }) => {
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

      const titleEls = Array.from(document.querySelectorAll(sel.caseTitleCell));
      for (const titleEl of titleEls) {
        const row = titleEl.parentElement;

        if (caseId) {
          const idEl = row?.querySelector(sel.caseIdCell);
          const rowId = idEl ? idEl.textContent.trim() : null;
          if (rowId !== caseId) continue;
        } else {
          const top = getAbsoluteTop(titleEl);
          if (top == null || top <= suiteBounds.top || top >= suiteBounds.boundaryTop) continue;
          const link = titleEl.querySelector(sel.caseTitleLink);
          const text = link ? link.textContent.trim() : '';
          if (text !== caseText) continue;
        }

        const statusEl = row?.querySelector(sel.caseStatusBadge);
        return statusEl ? statusEl.textContent.trim() : null;
      }
      return null; // row-nya belum/tidak ke-render saat ini
    },
    { caseId, caseText, suiteBounds, sel: SELECTORS }
  );
}

// Menunggu status case di panel list benar-benar berubah jadi Passed
// sebelum menganggap case ini selesai. Kalau tidak pernah tercapai, klik
// verdict-nya dianggap gagal alih-alih diam-diam dilaporkan sukses.
async function verifyCaseMarkedPassed(uatPage, caseText, caseId, suiteBounds) {
  let lastStatus = null;
  const checkStatus = async () => {
    lastStatus = await readCaseStatus(uatPage, { caseId, caseText, suiteBounds });
    return lastStatus != null && lastStatus.includes(TEXT.passedLabel);
  };

  // Coba dulu di posisi sekarang -- biasanya cukup, tinggal nunggu
  // request-nya kelar diproses server.
  let confirmed = await pollUntil(checkStatus, {
    intervalMs: TIMING.verdictConfirmIntervalMs,
    maxIterations: TIMING.verdictConfirmMaxIterations,
  });

  // Row-nya mungkin sedang tidak ke-render di posisi ini (list-nya
  // virtualized, bisa geser). Coba scroll cari dulu sebelum benar-benar
  // dianggap gagal.
  if (!confirmed) {
    const scrollContainer = uatPage.locator(SELECTORS.scrollContainer).first();
    const hasScrollContainer = (await scrollContainer.count()) > 0;
    if (hasScrollContainer) {
      const found = await scrollSearch(
        uatPage,
        scrollContainer,
        async () => ((await checkStatus()) ? 1 : -1),
        { direction: 1 }
      );
      confirmed = found !== -1;
    }
  }

  if (!confirmed) {
    await saveDebugScreenshot(uatPage, 'debug-uat-verdict-not-confirmed.png');
    throw new Error(
      `Verdict Passed untuk case "${caseText}" tidak terkonfirmasi -- status di list masih "${lastStatus ?? '(tidak terbaca)'}" setelah ditunggu.`
    );
  }
}

// Setelah relaunch browser (khususnya setelah crash), request pertama
// kadang ke-abort (net::ERR_ABORTED) karena network stack Chrome belum
// benar-benar siap sesaat setelah start.
async function gotoWithRetry(pg, url) {
  return retry(`buka ${url}`, RETRY_ATTEMPTS, async () => {
    try {
      await pg.goto(url);
    } catch (err) {
      await pg.waitForTimeout(TIMING.navRetryDelayMs);
      throw err;
    }
  });
}

// Membuka Projects -> project PROJECT_NAME -> Test Runs -> run UAT (tab
// baru) & SIT (tab awal). Dipisah dari main loop supaya jelas: ini murni
// langkah navigasi, tidak menyentuh logika retry/case processing.
async function openSitAndUatRuns(context) {
  const page = context.pages()[0] ?? (await context.newPage());

  await gotoWithRetry(page, PROJECTS_URL);

  // Profile ini belum pernah login -> tunggu login manual, session akan
  // tersimpan permanen ke USER_DATA_DIR untuk run-run berikutnya.
  if (page.url().includes('/login')) {
    console.log('Belum login di profile ini. Silakan login manual di browser yang terbuka (maks 5 menit)...');
    await page.waitForURL(/\/projects/, { timeout: LOGIN_TIMEOUT_MS });
    await gotoWithRetry(page, PROJECTS_URL); // ulang lagi supaya query search sesuai
  }

  const searchInput = page.getByRole('textbox').first();
  await searchInput.fill(PROJECT_NAME);

  await page.getByRole('link', { name: PROJECT_NAME, exact: true }).first().click();
  await page.getByRole('link', { name: 'Test Runs' }).click();

  // Buka run UAT di tab baru lewat Ctrl+Click ("open link in new tab")
  // supaya tidak perlu menyentuh context menu native browser yang tidak
  // bisa diotomasi Playwright.
  const [uatPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: UAT_RUN_PATTERN }).click({ modifiers: ['Control'] }),
  ]);
  await uatPage.waitForLoadState();

  await page.getByRole('link', { name: SIT_RUN_PATTERN }).click();

  return { page, uatPage };
}

// Membuat satu instance browser baru -- dipisah dari main loop supaya
// daftar argumen Chrome tidak terduplikasi tiap kali perlu relaunch
// setelah crash.
async function launchBrowser() {
  clearStaleSingletonLock();

  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null, // konten mengikuti ukuran window asli, bukan viewport tetap
    args: [
      '--start-maximized',
      // Kombinasi flag di bawah memaksa full software rendering. Mesin
      // ini sering mengalami GPU process crash (CommandBufferHelper::
      // AllocateRingBuffer failed) -- "--disable-gpu" saja ternyata
      // masih bisa menyalakan GPU process untuk compositing di sebagian
      // versi Chromium, jadi ditambahkan flag lain supaya command buffer
      // GPU-nya benar-benar tidak terpakai sama sekali.
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-rasterization',
      '--disable-accelerated-2d-canvas',
      '--disable-accelerated-video-decode',
      // Fitur occlusion-detection Windows ini sering bentrok saat
      // beberapa tab bergantian fokus (SIT <-> UAT terus-menerus) --
      // umum direkomendasikan dimatikan untuk automation di Windows.
      '--disable-features=CalculateNativeWinOcclusion',
      // Tanpa 3 flag ini Chrome men-throttle tab yang sedang di
      // background, menambah beban/timing tak menentu yang kemungkinan
      // ikut berkontribusi ke GPU crash di atas.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
}

(async () => {
  // null = belum pernah discan. Sekali discan, dipakai terus lintas
  // attempt (bukan discan ulang tiap relaunch) -- scan penuh butuh
  // scroll ratusan kali, mubazir diulang cuma karena browser crash di
  // tengah proses case.
  let remainingCases = null;
  // Case yang gagal karena data/DOM (bukan karena crash) -- tidak
  // diulang lagi di attempt berikutnya supaya tidak buang waktu mencoba
  // hal yang memang akan gagal lagi. Beda dengan case yang terputus
  // karena crash: itu tetap ada di depan antrian remainingCases, otomatis
  // dicoba lagi di attempt berikutnya.
  const permanentlyFailed = [];

  // Worker OCR di-init sekali lepas dari retry/relaunch browser --
  // cold-start-nya independen dari Chrome/Playwright, jadi tidak perlu
  // (dan tidak boleh) diulang tiap attempt.
  if (MASKING_ENABLED) await initMaskingWorker();

  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
    console.log(`\n=== Attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS} ===`);
    if (attempt > 1) {
      // Beri jeda supaya OS benar-benar melepas proses/handle Chrome
      // yang baru saja crash sebelum instance baru dijalankan ke profile
      // yang sama.
      await sleep(RELAUNCH_DELAY_MS);
    }

    let context;
    try {
      context = await launchBrowser();
      const { page, uatPage } = await openSitAndUatRuns(context);

      // Batas & posisi pixel suite dihitung ulang tiap kali browser baru
      // dibuka -- itu murni hasil render dari page instance yang sedang
      // aktif sekarang, beda dengan remainingCases (daftar case yang
      // belum diproses) yang memang harus dipertahankan lintas attempt
      // supaya progress tidak hilang tiap kali relaunch.
      await page.bringToFront();
      const sitSuite = await scanSuite(page, SUITE_TEXT);

      await uatPage.bringToFront();
      const uatSuite = await scanSuite(uatPage, SUITE_TEXT);

      if (remainingCases === null) {
        remainingCases = uatSuite.untested;
        if (CASE_TITLE_ALLOWLIST) {
          remainingCases = remainingCases.filter((c) => CASE_TITLE_ALLOWLIST.includes(c.title));
        }
        console.log(
          `Ketemu ${remainingCases.length} case Untested di suite "${SUITE_TEXT}":`,
          remainingCases.map((c) => `${c.title}${c.caseId ? ` (ID ${c.caseId})` : ''}`)
        );
      }

      while (remainingCases.length > 0) {
        if (page.isClosed() || uatPage.isClosed()) {
          console.error(`Browser/tab sudah tertutup (kemungkinan crash) -- ${remainingCases.length} case sisa ditunda ke attempt berikutnya.`);
          break;
        }
        const { title: caseText, caseId } = remainingCases[0];
        try {
          await processCase(page, uatPage, caseText, caseId, sitSuite, uatSuite);
          remainingCases.shift();
        } catch (err) {
          if (err instanceof EvidenceIntegrityError || err instanceof EvidenceMaskingError) {
            // Evidence integrity tidak bisa dipastikan (termasuk kalau
            // masking-nya sendiri yang gagal -- lihat evidence-masking.js)
            // -- stop total, jangan lanjut ke case lain (bisa saja
            // menyimpan/melampirkan evidence yang salah/tidak lengkap/
            // belum ter-mask tanpa ketahuan). Tutup browser dan keluar
            // dengan exit code non-zero supaya jelas ada yang error.
            console.error(`\n!!! FATAL: ${err.message}`);
            console.error('Berhenti total & menutup browser -- evidence integrity tidak bisa dipastikan, cek manual dulu sebelum lanjut.');
            if (context) await context.close().catch(() => {});
            // process.exit() di bawah ini synchronous -- kalau shutdown
            // worker/manifest dipindah ke luar (mis. lewat finally di
            // level lebih atas), itu TIDAK akan sempat jalan. Makanya
            // dipanggil eksplisit persis di sini, sebelum exit.
            if (MASKING_ENABLED) {
              await shutdownMaskingWorker();
              writeMaskingManifest(EVIDENCE_SIT_DIR);
            }
            process.exit(1);
          }
          if (isTargetClosedError(err)) {
            // Crash di tengah proses case ini -- jangan di-shift, biar
            // case-nya tetap di depan antrian dan dicoba ulang di
            // attempt berikutnya.
            console.error(`Browser/tab tertutup di tengah proses case "${caseText}" (kemungkinan crash) -- ditunda ke attempt berikutnya.`);
            break;
          }
          console.error(`GAGAL proses case "${caseText}": ${err.message}`);
          remainingCases.shift();
          permanentlyFailed.push(caseText);
        }
      }
    } catch (err) {
      console.error(`Attempt ${attempt} berhenti karena error fatal: ${err.message}`);
    } finally {
      if (context) await context.close().catch(() => {});
    }

    if (remainingCases !== null && remainingCases.length === 0) break;
    if (attempt < MAX_LAUNCH_ATTEMPTS) {
      console.log('Relaunch browser & lanjutkan sisa case (tanpa scan ulang dari awal, session tetap terpakai dari profile)...');
    }
  }

  if (remainingCases === null) {
    console.log(`Berhenti setelah ${MAX_LAUNCH_ATTEMPTS}x percobaan, browser terus gagal start/navigasi -- belum sempat scan case sama sekali.`);
  } else if (remainingCases.length > 0) {
    console.log(`Berhenti setelah ${MAX_LAUNCH_ATTEMPTS}x percobaan, browser keburu crash terus -- ${remainingCases.length} case belum sempat dicoba: ${remainingCases.map((c) => c.title).join(', ')}`);
  }
  if (permanentlyFailed.length > 0) {
    console.log(`${permanentlyFailed.length} case gagal karena masalah data/DOM (bukan crash), cek manual: ${permanentlyFailed.join(', ')}`);
  }
  if (remainingCases !== null && remainingCases.length === 0 && permanentlyFailed.length === 0) {
    console.log('Semua case selesai diproses.');
  }

  if (MASKING_ENABLED) {
    await shutdownMaskingWorker();
    writeMaskingManifest(EVIDENCE_SIT_DIR);
  }
})();
