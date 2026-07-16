// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Harness verifikasi offline untuk evidence-masking.js -- dijalankan
// MANUAL, SEKALI, sebelum fitur masking pernah dipasang aktif ke run
// `node main.js` yang sesungguhnya. Sama sekali tidak menyentuh
// Playwright/browser/Qase, cuma memproses file gambar yang sudah ada di
// disk lewat pipeline masking yang sama persis dipakai di main.js.
//
// Cara pakai: node scripts/test-masking-offline.js [folder-input]
// Default folder-input: EVIDENCE_SIT_DIR dari config.js (evidence asli
// yang sudah ada, dikonfirmasi dummy data).

const fs = require('fs');
const path = require('path');
const { EVIDENCE_SIT_DIR } = require('../config');
const { initMaskingWorker, shutdownMaskingWorker, maskEvidenceImage, writeMaskingManifest } = require('../evidence-masking');

const inputDir = process.argv[2] || EVIDENCE_SIT_DIR;
const outputDir = path.join(__dirname, '..', '.masking-offline-output');

(async () => {
  if (!fs.existsSync(inputDir)) {
    console.error(`Folder input tidak ditemukan: ${inputDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(inputDir).filter((f) => f.toLowerCase().endsWith('.png'));
  if (files.length === 0) {
    console.error(`Tidak ada file .png di ${inputDir}`);
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`Memproses ${files.length} gambar dari ${inputDir}`);
  console.log(`Output masked disimpan ke ${outputDir}\n`);

  await initMaskingWorker();

  let failed = 0;
  let skipped = 0;
  const startedAt = Date.now();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      // Folder input bisa saja berubah isinya di tengah proses batch
      // (ratusan file, prosesnya bisa berjalan lama) -- file yang
      // hilang di antara listing awal dan baca ini di-skip, bukan
      // menghentikan seluruh batch.
      const buffer = fs.readFileSync(path.join(inputDir, file));
      const { maskedBuffer, manifestEntry } = await maskEvidenceImage(buffer, { sourceLabel: file });
      fs.writeFileSync(path.join(outputDir, file), maskedBuffer);
      console.log(
        `[${i + 1}/${files.length}] ${file} -- ${manifestEntry.regionCount} region, label: [${manifestEntry.labelsMatched.join(', ')}], badge: ${manifestEntry.badgeZonesMasked}, ${manifestEntry.totalMs}ms`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        skipped++;
        console.error(`[${i + 1}/${files.length}] ${file} -- DILEWATI (file sudah tidak ada saat dibaca)`);
        continue;
      }
      failed++;
      console.error(`[${i + 1}/${files.length}] ${file} -- GAGAL: ${err.message}`);
    }
  }

  await shutdownMaskingWorker();
  const manifestPath = writeMaskingManifest(outputDir);
  const totalMs = Date.now() - startedAt;

  console.log(`\nSelesai: ${files.length} gambar, ${failed} gagal, ${skipped} dilewati (file hilang), total ${(totalMs / 1000).toFixed(1)}s (rata-rata ${(totalMs / files.length).toFixed(0)}ms/gambar).`);
  console.log(`Manifest: ${manifestPath}`);
  console.log('Langkah berikutnya: buka folder output di atas, bandingkan visual dengan gambar aslinya, dan cek daftar "imagesWithZeroRegions" di manifest.');

  process.exit(failed > 0 ? 1 : 0);
})();
