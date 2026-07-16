// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Masking otomatis data sensitif (rekening, saldo, nama, dokumen bisnis,
// dsb.) di evidence sebelum di-copy dari SIT ke UAT. Full-otomatis, tidak
// ada gate review manual per-gambar -- karena itu, setiap pilihan yang
// ambigu di modul ini sengaja diselesaikan ke arah over-masking dan
// gagal-secara-nyaring, bukan "tebakan terbaik lalu lanjut". Lihat
// README.md bagian "Masking evidence sensitif" untuk konteks lengkap.

const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const { createWorker } = require('tesseract.js');

// Flag darurat bypass -- TIDAK direkomendasikan dimatikan untuk run yang
// evidence-nya bakal di-attach ke UAT sungguhan. Cuma buat debugging lokal.
const MASKING_ENABLED = true;

const MASKING = {
  ocrLanguages: ['ind', 'eng'],
  ocrTimeoutMs: 30000,
  // Teks kecil/padat (mis. tabel yang di-screenshot dalam kondisi zoom
  // out) kadang gagal terbaca SAMA SEKALI oleh OCR di resolusi asli --
  // upscale sebelum OCR terbukti empiris menaikkan akurasi buat kasus
  // itu (lihat catatan verifikasi offline), dengan konsekuensi waktu OCR
  // per gambar naik kira-kira sebanding dengan faktor ini.
  ocrUpscaleFactor: 2,
  // Kata hasil OCR dengan confidence di bawah ini dibuang SEBELUM
  // digabung jadi frasa/dicocokkan ke label -- kata yang salah baca
  // parah (glyph/ikon kebaca jadi teks acak) biasanya juga confidence-nya
  // rendah DAN bounding box-nya aneh (kelewat tinggi/lebar), yang kalau
  // dibiarkan bisa "menjembatani" dua baris UI yang sebenarnya tidak
  // berhubungan (lihat catatan verifikasi offline) dan memicu masking
  // meluas. Regex safety net TETAP jalan di semua kata tanpa filter ini
  // -- disengaja, karena untuk itu risiko under-masking harus diutamakan
  // di atas noise.
  minWordConfidenceForPhrase: 55,
  // Kotak solid opaque, BUKAN blur/pixelate -- blur bisa direkonstruksi
  // sebagian dan tidak defensible sebagai "redaction" kalau ditanya auditor.
  maskColor: { r: 0, g: 0, b: 0, a: 255 },
  regionPaddingPx: 6,

  // Katalog label field sensitif, hasil peninjauan langsung evidence asli
  // (dummy) lintas modul PNM: Master Bank/Rekening, Dashboard Rekening,
  // Ulamm/Mekaar, Daftar Aset & Inventaris/Mutasi/Penghapusbukuan.
  // `labels` berisi alias ejaan yang mungkin muncul (variasi spasi/titik/
  // singkatan). `basis` mendokumentasikan KENAPA field ini di-mask --
  // rujukan kategori data pribadi UU PDP No. 27/2022 (data pribadi
  // umum = Pasal 4 ayat 2, data pribadi spesifik = Pasal 4 ayat 3) dan/
  // atau kewajiban perlindungan data konsumen POJK No. 6/POJK.07/2022,
  // kombinasi dengan konteks PNM sebagai anak usaha BRI (lembaga jasa
  // keuangan di bawah pengawasan OJK) -- supaya tiap entry bisa dijawab
  // ke auditor/kabag QA, bukan cuma "kelihatannya sensitif".
  labelCatalog: [
    {
      labels: ['Nomor Rekening', 'No Rekening', 'No. Rekening'],
      basis: 'Data pribadi spesifik (data keuangan) -- UU PDP Ps. 4(3); data transaksi/rekening konsumen jasa keuangan -- POJK 6/2022.',
    },
    {
      labels: ['Saldo'],
      basis: 'Data pribadi spesifik (data keuangan) -- UU PDP Ps. 4(3); data keuangan konsumen -- POJK 6/2022.',
    },
    {
      labels: ['Total Saldo Terkelola'],
      basis: 'Agregat data keuangan spesifik -- sama seperti "Saldo", plus berpotensi mengungkap skala aset yang dikelola (confidential secara bisnis).',
    },
    {
      labels: ['Nilai Buku Audit'],
      basis: 'Data finansial internal perusahaan (nilai aset hasil audit) -- confidential secara bisnis, bukan data pribadi UU PDP.',
    },
    {
      labels: ['Nilai Buku'],
      basis: 'Data finansial internal perusahaan (nilai buku aset) -- confidential secara bisnis, bukan data pribadi UU PDP.',
    },
    {
      labels: ['Harga Perolehan'],
      basis: 'Data finansial internal perusahaan (nilai perolehan aset) -- confidential secara bisnis, bukan data pribadi UU PDP.',
    },
    {
      labels: ['Penyusutan/Bulan', 'Penyusutan / Bulan', 'Penyusutan'],
      basis: 'Data finansial internal perusahaan (penyusutan aset) -- confidential secara bisnis, bukan data pribadi UU PDP.',
    },
    {
      labels: ['Nama Pemilik'],
      basis: 'Data pribadi umum (nama lengkap) -- UU PDP Ps. 4(2); identitas nasabah/pemilik rekening -- POJK 6/2022.',
    },
    {
      labels: ['USER ID'],
      basis: 'Data pribadi umum (nama pegawai internal yang memproses transaksi) -- UU PDP Ps. 4(2).',
    },
    {
      labels: ['No. Invoice', 'No Invoice'],
      basis: 'Dokumen bisnis internal (traceable ke vendor/kontrak) -- confidential secara bisnis, bukan data pribadi UU PDP.',
    },
    {
      labels: ['No. SPK/PO', 'No SPK/PO', 'No. SPK', 'No. PO'],
      basis: 'Dokumen bisnis internal (traceable ke vendor/kontrak) -- confidential secara bisnis, bukan data pribadi UU PDP.',
    },
    {
      labels: ['Lokasi'],
      basis: 'Lokasi fisik aset -- security-sensitive untuk aset bernilai tinggi (bukan data pribadi UU PDP kecuali terhubung ke lokasi individu).',
    },
  ],

  // Badge nama+role user yang login tidak punya label field sama sekali --
  // cuma dirender langsung. Ancor UTAMA-nya teks "Logout" -- kata umum
  // yang jauh lebih reliable kebaca OCR dibanding nama orang/kode role
  // (yang bisa apa saja), dan selalu ada tepat di bawah badge nama+role
  // di semua sampel desktop portal yang sudah ditinjau. roleKeywords
  // dipertahankan sebagai jaring KEDUA untuk badge yang posisinya beda
  // (mis. tidak ada tombol Logout di crop layar itu).
  // basis: data pribadi umum (nama + jabatan pegawai internal) -- UU PDP
  // Ps. 4(2).
  loginBadge: {
    logoutMarkerText: ['Logout'],
    roleKeywords: ['Kantor Pusat', 'PPI Kantor Pusat', 'HCD', 'ATI'],
    basis: 'Data pribadi umum (nama + jabatan pegawai yang login) -- UU PDP Ps. 4(2).',
  },

  // Jaring pengaman independen dari label -- jalan di semua token teks
  // apa pun konteksnya, buat nangkep nilai yang kelewat dari pencocokan
  // label (mis. layout baru yang belum ada di labelCatalog). `basis`
  // sama seperti labelCatalog -- lihat komentar di atas.
  regexSafetyNet: [
    { name: 'nik16', pattern: /\b\d{16}\b/, basis: 'NIK -- data pribadi spesifik, UU PDP Ps. 4(3).' },
    { name: 'longDigits', pattern: /\b\d{10,}\b/, basis: 'Kemungkinan nomor rekening/identitas panjang yang lolos dari label -- lihat basis "Nomor Rekening".' },
    { name: 'phoneId', pattern: /\b08\d{8,11}\b/, basis: 'Nomor HP -- data pribadi umum, UU PDP Ps. 4(2).' },
    { name: 'rupiah', pattern: /\bRp\.?\s?[\d.,]{4,}\b/i, basis: 'Nominal uang -- lihat basis "Saldo"/data finansial internal, tergantung konteks.' },
  ],
};

// Dilempar kalau OCR gagal total (engine error/timeout) -- integritas
// masking tidak bisa dipastikan, jadi ini diperlakukan sefatal
// EvidenceIntegrityError di main.js (never let an unmasked image slip
// through karena proses maskingnya sendiri gagal diam-diam). OCR yang
// SUKSES tapi tidak menemukan apa-apa itu valid ("memang tidak ada yang
// perlu dimasking"), bukan error -- beda kasus, lihat maskEvidenceImage.
class EvidenceMaskingError extends Error {}

// Worker OCR di-init sekali per run (bukan per gambar) karena cold-start-nya
// beberapa detik -- kalau per-gambar, run dengan ratusan evidence jadi
// nggak masuk akal durasinya. Lifecycle-nya independen dari retry/relaunch
// browser di main.js, makanya disimpan sebagai module-level state di sini.
let worker = null;
let runStartedAt = null;
let manifestEntries = [];

async function initMaskingWorker() {
  runStartedAt = new Date().toISOString();
  manifestEntries = [];
  worker = await createWorker(MASKING.ocrLanguages);
}

async function shutdownMaskingWorker() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

function withTimeout(promise, ms, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function normalizeText(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Toleran ke noise hasil OCR (salah baca 1-2 karakter) -- exact match akan
// kelewat banyak kasus nyata (mis. "Nomor Rekenlng" salah baca "i" jadi "l").
function matchLineAgainstLabels(lineText, labels) {
  const normalizedLine = normalizeText(lineText);
  if (!normalizedLine) return null;
  const lineWords = normalizedLine.split(' ');
  for (const label of labels) {
    const normalizedLabel = normalizeText(label);
    // Dibatasi panjangnya -- tanpa batas ini, frasa bisa nyantol di
    // TENGAH kalimat/caption/judul UI yang cuma kebetulan menyebut kata
    // itu (mis. "Total Saldo Per Bank (Dalam Jutaan Rp)" atau "Saldo dan
    // seluruh Rekening aktif yang terdaftar" nyantol ke label "Saldo"),
    // padahal itu bukan value field yang perlu dimasking. Berlaku ke
    // KEDUA jalur di bawah (substring maupun windowed-distance) --
    // windowed-distance sendirian tetap bisa nemu 1 kata match persis di
    // tengah frasa panjang kalau ini tidak dicek duluan.
    if (normalizedLine.length > normalizedLabel.length + 20) continue;
    if (normalizedLine.includes(normalizedLabel)) return label;
    const labelWords = normalizedLabel.split(' ');
    // Toleransi 25% cuma masuk akal buat label yang cukup panjang --
    // label pendek (mis. "ATI", "HCD") wajib exact match, karena 1 huruf
    // beda di kata sependek itu bukan lagi "noise OCR", itu udah kata
    // lain (kejadian nyata: "AT" potongan nama "PRAMDOEDYA AT" kebaca
    // beda 1 huruf dari "ATI" dan salah kena mask -- lihat catatan
    // verifikasi offline).
    const maxDistance = normalizedLabel.length <= 4 ? 0 : Math.max(1, Math.ceil(normalizedLabel.length * 0.25));
    for (let i = 0; i <= lineWords.length - labelWords.length; i++) {
      const windowText = lineWords.slice(i, i + labelWords.length).join(' ');
      if (levenshtein(windowText, normalizedLabel) <= maxDistance) return label;
    }
  }
  return null;
}

function flattenLines(blocks) {
  if (!blocks) return [];
  const lines = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) lines.push(line);
    }
  }
  return lines;
}

function flattenWords(lines) {
  const words = [];
  for (const line of lines) {
    for (const word of line.words || []) words.push(word);
  }
  return words;
}

function average(nums) {
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Line-level bbox dari tesseract kadang menggabung dua kolom yang jauh
// terpisah jadi SATU "line" kalau posisi y-nya kebetulan mepet (mis. di
// UI form 2-kolom, "Nama Pemilik" di kiri dan "Bank" di kanan bisa
// terbaca sebagai satu baris dengan bbox selebar hampir seluruh gambar).
// Kalau bbox label yang sudah kelewat lebar itu dipakai langsung, region
// masking-nya otomatis ikut kelewat lebar juga -- regrouping manual di
// bawah ini menyatukan ulang kata-per-kata berdasarkan jarak visual ASLI
// (bukan struktur line dari tesseract), supaya kolom yang jauh tetap
// jadi frasa terpisah walau y-nya kebetulan sejajar.
function groupWordsIntoPhrases(words) {
  const sorted = [...words].sort((a, b) => {
    const ay = (a.bbox.y0 + a.bbox.y1) / 2;
    const by = (b.bbox.y0 + b.bbox.y1) / 2;
    if (Math.abs(ay - by) > 4) return ay - by;
    return a.bbox.x0 - b.bbox.x0;
  });

  const phrases = [];
  let current = null;
  for (const word of sorted) {
    const w = word.bbox;
    if (current) {
      const overlap = Math.min(current.y1, w.y1) - Math.max(current.y0, w.y0);
      const refHeight = Math.max(current.y1 - current.y0, w.y1 - w.y0, 1);
      const sameRow = overlap > refHeight * 0.4;
      const gap = w.x0 - current.x1;
      // Celah antar-kata dalam satu frasa biasanya jauh lebih kecil dari
      // tinggi teksnya sendiri -- celah sebesar itu atau lebih dianggap
      // sudah pindah ke elemen/kolom lain, bukan lagi frasa yang sama.
      if (sameRow && gap <= refHeight * 1.5) {
        current.text += ` ${word.text}`;
        current.x0 = Math.min(current.x0, w.x0);
        current.y0 = Math.min(current.y0, w.y0);
        current.x1 = Math.max(current.x1, w.x1);
        current.y1 = Math.max(current.y1, w.y1);
        continue;
      }
      phrases.push(current);
    }
    current = { text: word.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
  }
  if (current) phrases.push(current);

  return phrases.map((p) => ({ text: p.text, bbox: { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1 } }));
}

// Baris lain yang secara vertikal "sejajar" dengan `line` -- dipakai buat
// bedain header tabel (beberapa label pendek berjejer di baris yang sama)
// dari label form biasa (berdiri sendiri).
function findSameRowLines(line, allLines) {
  const rowHeight = line.bbox.y1 - line.bbox.y0;
  return allLines.filter((other) => {
    if (other === line) return false;
    const overlap = Math.min(line.bbox.y1, other.bbox.y1) - Math.max(line.bbox.y0, other.bbox.y0);
    return overlap > rowHeight * 0.4;
  });
}

function looksLikeHeaderRow(line, allLines) {
  // Ambang 2 kelewat longgar -- form 2-kolom biasa (mis. "Nama Pemilik"
  // kiri, "Bank" kanan) juga punya persis 1 "teman sebaris", jadi ke-
  // deteksi salah sebagai header tabel (lihat catatan verifikasi
  // offline: ini bikin computeColumnCellRegions nyari "value" di
  // SELURUH sisa gambar di bawahnya). Tabel sungguhan di semua modul
  // yang sudah ditinjau selalu punya jauh lebih dari 3 kolom header,
  // jadi ambang ini masih aman buat kasus tabel sambil menyingkirkan
  // form 2-kolom.
  return findSameRowLines(line, allLines).length >= 3;
}

function nextColumnBoundary(line, allLines, imageWidth) {
  const toRight = findSameRowLines(line, allLines)
    .filter((other) => other.bbox.x0 > line.bbox.x1)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return toRight.length > 0 ? toRight[0].bbox.x0 : imageWidth;
}

// Frasa yang duduk PERSIS di atas `line` (dalam beberapa baris tinggi) dan
// x-nya beririsan -- dipakai buat nemuin baris nama di atas baris role
// (mis. "HCD"). Role biasanya lebih PENDEK dari nama orangnya, jadi lebar
// box tidak boleh dihitung dari lebar teks role sendirian -- itu bikin
// nama panjang kepotong (lihat catatan verifikasi offline).
function findPhraseAbove(line, allLines) {
  const lineHeight = line.bbox.y1 - line.bbox.y0;
  let best = null;
  for (const other of allLines) {
    if (other === line) continue;
    const gap = line.bbox.y0 - other.bbox.y1;
    const xOverlap = Math.min(other.bbox.x1, line.bbox.x1) - Math.max(other.bbox.x0, line.bbox.x0);
    if (gap >= -2 && gap <= lineHeight * 3 && xOverlap > -lineHeight * 3) {
      if (!best || other.bbox.y1 > best.bbox.y1) best = other;
    }
  }
  return best;
}

// Semua frasa dalam SATU band vertikal di atas `line`, bukan cuma "yang
// paling dekat" -- dipakai khusus buat badge login, karena rantai
// "cari 1 di atas, lalu 1 lagi di atasnya" (findPhraseAbove dipanggil 2x)
// putus total kalau salah satu baris di tengah (mis. role "HCD") gagal
// terbaca OCR sama sekali: jaraknya ke baris nama jadi kelewat jauh buat
// dianggap "langsung di atas". Ngumpulin semua yang ada di band lebar
// sekali jalan jauh lebih tahan terhadap OCR yang bolong di tengah.
function findPhrasesInBandAbove(line, allLines, verticalRangeMultiplier, xToleranceMultiplier) {
  const lineHeight = line.bbox.y1 - line.bbox.y0;
  const verticalRange = lineHeight * verticalRangeMultiplier;
  const xTolerance = lineHeight * xToleranceMultiplier;
  return allLines.filter((other) => {
    if (other === line) return false;
    const withinY = other.bbox.y1 <= line.bbox.y0 + 2 && other.bbox.y0 >= line.bbox.y0 - verticalRange;
    const withinX = other.bbox.x0 <= line.bbox.x1 + xTolerance;
    return withinY && withinX;
  });
}

// Untuk header kolom tabel: alih-alih satu kotak besar dari bawah header
// sampai dasar gambar (rapi buat leak-prevention tapi jelek dilihat --
// ikut menutup whitespace/elemen lain di bawahnya yang kebetulan ada di
// x-band yang sama), cari SETIAP frasa yang benar-benar ada di bawah
// header ini dalam x-band kolomnya, lalu tutup masing-masing secara
// presisi. Tetap otomatis meng-cover berapa pun jumlah barisnya (tidak
// butuh tahu jumlah baris di muka) tanpa menutup area yang sebenarnya
// kosong/tidak relevan.
function computeColumnCellRegions(headerLine, allLines, imageWidth, pad) {
  const leftBound = headerLine.bbox.x0 - pad;
  const rightBound = nextColumnBoundary(headerLine, allLines, imageWidth);
  const regions = [];
  for (const line of allLines) {
    if (line === headerLine || line.bbox.y0 <= headerLine.bbox.y1) continue;
    const lineWidth = line.bbox.x1 - line.bbox.x0;
    const xOverlap = Math.min(line.bbox.x1, rightBound) - Math.max(line.bbox.x0, leftBound);
    if (xOverlap > lineWidth * 0.5) {
      regions.push({ x0: line.bbox.x0 - pad, y0: line.bbox.y0 - pad, x1: line.bbox.x1 + pad, y1: line.bbox.y1 + pad });
    }
  }
  return regions;
}

// Untuk tiap label yang match, hitung SEMUA kandidat region yang mungkin
// berlaku (bukan klasifikasi "field ini pasti bentuk form/tabel") --
// menghindari klasifikasi layout yang rapuh, dengan biaya over-masking
// yang murah kalau ternyata salah satu kandidat tidak relevan.
function computeLabelRegions(lines, imageWidth, imageHeight) {
  const regions = [];
  const pad = MASKING.regionPaddingPx;

  for (const entry of MASKING.labelCatalog) {
    for (const line of lines) {
      const matchedLabel = matchLineAgainstLabels(line.text, entry.labels);
      if (!matchedLabel) continue;
      const { bbox } = line;
      const labelWidth = bbox.x1 - bbox.x0;
      const labelHeight = bbox.y1 - bbox.y0;
      // Header kolom tabel dan label field form itu 2 bentuk yang beda --
      // header sendiri cuma nama kolom (bukan value, tidak perlu dimask),
      // yang perlu ditutup adalah VALUE-nya di baris-baris di bawahnya.
      // Kalau baris ini kelihatan seperti header (beberapa label pendek
      // berjejer), jalur below-block/inline-right (yang didesain buat
      // form field tunggal) dilewati sama sekali -- keduanya cuma bikin
      // kotak tambahan yang nempel di header itu sendiri, tidak berguna.
      const isHeader = labelWidth < imageWidth * 0.2 && looksLikeHeaderRow(line, lines);

      if (isHeader) {
        for (const cell of computeColumnCellRegions(line, lines, imageWidth, pad)) {
          regions.push({ ...cell, source: 'label', label: matchedLabel });
        }
        continue;
      }

      // Batas kanan yang dipakai below-block & inline-right -- form di UI
      // ini sering 2 kolom sejajar (mis. "Nama Pemilik" kiri, "Bank"
      // kanan), jadi region TIDAK boleh polos sampai tepi gambar (itu
      // bikin field kolom sebelah yang tidak sensitif ikut ke-mask).
      // Dibatasi ke posisi teks berikutnya di baris yang sama kalau ada.
      const rowBoundary = nextColumnBoundary(line, lines, imageWidth);

      // Layout form di UI ini: label di atas, value di dalam kotak
      // langsung di bawahnya (bukan di sebelah kanan) -- lihat sampel
      // "Ubah Data Bank"/"Tambah Data Bank".
      regions.push({
        x0: bbox.x0 - pad,
        x1: Math.min(rowBoundary, bbox.x0 + Math.max(labelWidth * 4, 250)),
        y0: bbox.y1,
        y1: Math.min(imageHeight, bbox.y1 + labelHeight * 3),
        source: 'label',
        label: matchedLabel,
      });

      // Jaring tambahan kalau ternyata ada layout "Label: value" sebaris
      // yang belum ketemu di sampel yang ditinjau.
      regions.push({
        x0: bbox.x1 + pad,
        x1: rowBoundary,
        y0: bbox.y0 - pad,
        y1: bbox.y1 + pad,
        source: 'label',
        label: matchedLabel,
      });
    }
  }
  return regions;
}

// Union bbox dari beberapa phrase + padding proporsional ke tinggi
// baris -- dipakai buat gabungin nama+role jadi satu region presisi.
function unionPhraseRegion(phrases, imageWidth, pad) {
  const x0 = Math.min(...phrases.map((p) => p.bbox.x0));
  const x1 = Math.max(...phrases.map((p) => p.bbox.x1));
  const y0 = Math.min(...phrases.map((p) => p.bbox.y0));
  const y1 = Math.max(...phrases.map((p) => p.bbox.y1));
  const h = Math.max(...phrases.map((p) => p.bbox.y1 - p.bbox.y0));
  return {
    x0: Math.max(0, x0 - h * 0.5),
    x1: Math.min(imageWidth, x1 + h * 0.5),
    y0: Math.max(0, y0 - h * 0.5),
    y1: y1 + pad,
  };
}

function computeLoginBadgeRegions(lines, imageWidth) {
  const regions = [];
  let matched = false;
  const handledAsNameOrRole = new Set();
  const pad = MASKING.regionPaddingPx;

  for (const line of lines) {
    // Ancor utama: tombol "Logout" -- kata umum, jauh lebih reliable
    // kebaca OCR dibanding nama orang/kode role yang bisa apa saja (kode
    // role kayak "HCD" kadang gagal terbaca sama sekali walau elemen
    // UI-nya konsisten selalu ada -- lihat catatan verifikasi offline).
    // Baris tepat di atas "Logout" adalah role, dan di atas role lagi
    // adalah nama -- keduanya di-mask (Logout sendiri TIDAK, itu bukan
    // data sensitif), lebar/tinggi menyesuaikan apa pun yang ketemu.
    if (!matchLineAgainstLabels(line.text, MASKING.loginBadge.logoutMarkerText)) continue;
    const toMask = findPhrasesInBandAbove(line, lines, 8, 10);
    if (toMask.length === 0) continue;
    matched = true;
    for (const p of toMask) handledAsNameOrRole.add(p);
    regions.push({ ...unionPhraseRegion(toMask, imageWidth, pad), source: 'loginBadge', zone: 'above-logout' });
  }

  // Jaring kedua: kalau tombol "Logout" tidak ketemu di crop ini (mis.
  // screenshot ter-scroll), tetap coba lewat kata kunci role/divisi
  // seperti sebelumnya.
  for (const line of lines) {
    if (handledAsNameOrRole.has(line)) continue;
    const matchedKeyword = matchLineAgainstLabels(line.text, MASKING.loginBadge.roleKeywords);
    if (!matchedKeyword) continue;
    matched = true;
    const nameLine = findPhraseAbove(line, lines);
    const toMask = [line, nameLine].filter(Boolean);
    regions.push({ ...unionPhraseRegion(toMask, imageWidth, pad), source: 'loginBadge', zone: `role-keyword:${matchedKeyword}` });
  }

  return { regions, matched };
}

function computeRegexRegions(words, phrases) {
  const regions = [];
  const hits = new Set();
  const pad = MASKING.regionPaddingPx;

  for (const word of words) {
    const normalized = word.text.replace(/\s+/g, '');
    for (const rule of MASKING.regexSafetyNet) {
      if (rule.pattern.test(normalized)) {
        regions.push({ x0: word.bbox.x0 - pad, y0: word.bbox.y0 - pad, x1: word.bbox.x1 + pad, y1: word.bbox.y1 + pad, source: 'regex', rule: rule.name });
        hits.add(rule.name);
      }
    }
  }
  // OCR kadang misahin satu angka jadi beberapa token karena ada spasi
  // liar ("0812 3456 7890") -- kalau gabungan satu frasa match tapi tidak
  // ada token tunggal yang match, mask seluruh frasa itu sebagai fallback
  // kasar (tidak bisa diatribusikan ke sub-token box mana yang tepat).
  // Pakai `phrases` (hasil regroup), BUKAN line mentah dari tesseract --
  // line mentah bisa menggabung 2 kolom yang jauh jadi 1 bbox lebar
  // (lihat groupWordsIntoPhrases), yang bikin fallback ini over-masking.
  for (const phrase of phrases) {
    const normalizedPhrase = phrase.text.replace(/\s+/g, '');
    for (const rule of MASKING.regexSafetyNet) {
      if (rule.pattern.test(normalizedPhrase)) {
        regions.push({ x0: phrase.bbox.x0 - pad, y0: phrase.bbox.y0 - pad, x1: phrase.bbox.x1 + pad, y1: phrase.bbox.y1 + pad, source: 'regex', rule: rule.name });
        hits.add(rule.name);
      }
    }
  }
  return { regions, hits: Array.from(hits) };
}

function clampRegion(region, imageWidth, imageHeight) {
  return {
    ...region,
    x0: Math.max(0, Math.floor(region.x0)),
    y0: Math.max(0, Math.floor(region.y0)),
    x1: Math.min(imageWidth, Math.ceil(region.x1)),
    y1: Math.min(imageHeight, Math.ceil(region.y1)),
  };
}

function fillRegion(image, region) {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  if (w <= 0 || h <= 0) return;
  const { r, g, b, a } = MASKING.maskColor;
  image.scan(region.x0, region.y0, w, h, function fillPixel(x, y, idx) {
    this.bitmap.data[idx + 0] = r;
    this.bitmap.data[idx + 1] = g;
    this.bitmap.data[idx + 2] = b;
    this.bitmap.data[idx + 3] = a;
  });
}

// Fungsi inti -- dipanggil sekali per gambar evidence. `context.sourceLabel`
// cuma dipakai buat pesan error/manifest (identitas case/step si gambar).
async function maskEvidenceImage(buffer, context) {
  if (!worker) {
    throw new EvidenceMaskingError('Worker OCR belum diinisialisasi -- panggil initMaskingWorker() dulu sebelum maskEvidenceImage().');
  }

  const startedAt = Date.now();
  const image = await Jimp.read(buffer);
  const imageWidth = image.width;
  const imageHeight = image.height;

  // OCR jalan di salinan yang di-upscale + grayscale+contrast (bantu OCR
  // baca font UI yang kecil/tipis -- teks di tabel yang di-screenshot
  // zoom-out kadang gagal terbaca SAMA SEKALI di resolusi asli), masking
  // beneran ditimpa ke gambar ASLI (resolusi asli, warna asli) supaya
  // evidence yang tidak di-mask tetap sama seperti aslinya.
  const upscale = MASKING.ocrUpscaleFactor;
  const ocrBuffer = await image
    .clone()
    .resize({ w: imageWidth * upscale, h: imageHeight * upscale })
    .greyscale()
    .contrast(0.15)
    .getBuffer('image/png');

  let result;
  const ocrStartedAt = Date.now();
  try {
    result = await withTimeout(
      worker.recognize(ocrBuffer, {}, { blocks: true }),
      MASKING.ocrTimeoutMs,
      `OCR timeout (${MASKING.ocrTimeoutMs}ms) untuk ${context.sourceLabel}`
    );
  } catch (err) {
    // OCR gagal total (bukan "tidak nemu teks", tapi engine-nya error/
    // timeout) -- integritas masking tidak bisa dipastikan, harus fatal.
    throw new EvidenceMaskingError(`OCR gagal untuk ${context.sourceLabel}: ${err.message}`);
  }
  const ocrMs = Date.now() - ocrStartedAt;

  const lines = flattenLines(result.data.blocks);
  // Koordinat bbox dari tesseract mengikuti gambar yang di-upscale --
  // dibagi balik ke skala gambar ASLI di sini, SEKALI, sebelum dipakai
  // fungsi region manapun, supaya kode di bawah tidak perlu tahu soal
  // upscaling sama sekali.
  const words = flattenWords(lines).map((word) => ({
    ...word,
    bbox: {
      x0: word.bbox.x0 / upscale,
      y0: word.bbox.y0 / upscale,
      x1: word.bbox.x1 / upscale,
      y1: word.bbox.y1 / upscale,
    },
  }));
  // `phrases` (bukan `lines`) yang dipakai buat semua logic penentuan
  // region -- lihat groupWordsIntoPhrases soal kenapa line mentah dari
  // tesseract tidak bisa dipercaya langsung buat ini. Kata confidence
  // rendah dibuang dulu sebelum digabung -- lihat minWordConfidenceForPhrase.
  const phrases = groupWordsIntoPhrases(words.filter((w) => w.confidence >= MASKING.minWordConfidenceForPhrase));

  const labelRegionsRaw = computeLabelRegions(phrases, imageWidth, imageHeight);
  const loginBadge = computeLoginBadgeRegions(phrases, imageWidth);
  const regexResult = computeRegexRegions(words, phrases);

  if (process.env.MASK_DEBUG) {
    console.error('PHRASES:', JSON.stringify(phrases, null, 1));
    console.error('LABEL REGIONS:', JSON.stringify(labelRegionsRaw, null, 1));
    console.error('BADGE REGIONS:', JSON.stringify(loginBadge, null, 1));
  }

  const allRegions = [...labelRegionsRaw, ...loginBadge.regions, ...regexResult.regions]
    .map((r) => clampRegion(r, imageWidth, imageHeight))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);

  for (const region of allRegions) fillRegion(image, region);

  const maskedBuffer = await image.getBuffer('image/png');

  const manifestEntry = {
    sourceLabel: context.sourceLabel,
    regionCount: allRegions.length,
    labelsMatched: Array.from(new Set(labelRegionsRaw.map((r) => r.label))),
    regexHits: regexResult.hits,
    badgeZonesMasked: loginBadge.matched,
    ocrWordCount: words.length,
    ocrAvgConfidence: average(words.map((w) => w.confidence)),
    ocrMs,
    totalMs: Date.now() - startedAt,
  };
  manifestEntries.push(manifestEntry);

  return { maskedBuffer, manifestEntry };
}

// Ditulis sekali di akhir run (bukan per gambar) -- satu-satunya jaring
// pengaman retrospektif karena tidak ada gate review manual per-gambar.
// `imagesWithZeroRegions` adalah angka paling penting buat spot-check: QA
// lead cukup cek daftar itu dulu, tidak perlu buka semua gambar satu-satu.
function writeMaskingManifest(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, `masking-manifest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const summary = {
    totalImages: manifestEntries.length,
    imagesWithZeroRegions: manifestEntries.filter((e) => e.regionCount === 0).length,
  };
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ runStartedAt, maskingEnabled: MASKING_ENABLED, images: manifestEntries, summary }, null, 2)
  );
  console.log(`Manifest masking disimpan: ${manifestPath} (${summary.totalImages} gambar, ${summary.imagesWithZeroRegions} tanpa region masking)`);
  return manifestPath;
}

module.exports = {
  MASKING_ENABLED,
  MASKING,
  EvidenceMaskingError,
  initMaskingWorker,
  shutdownMaskingWorker,
  maskEvidenceImage,
  writeMaskingManifest,
};
