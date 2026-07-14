// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Konfigurasi yang dipakai bareng oleh main.js, compare-suite.js, dan
// debug-case354.js. Kalau mau mengarahkan seluruh script ini ke project
// atau run Qase yang lain (misal dipakai orang lain / tim lain), cukup
// ganti nilai di sini -- tidak perlu dicari & diubah satu per satu di
// tiap file.
//
// (inspect-case.js sengaja tidak ikut memakai file ini -- itu script debug
// sekali-pakai dengan URL run & case yang di-hardcode langsung, bukan
// diturunkan dari PROJECT_NAME/RUN_TITLE.)

const path = require('path');
const os = require('os');

const PROJECT_NAME = 'YOUR_PROJECT_NAME';
const RUN_TITLE = 'Contoh';
const RUN_TITLE_UAT = 'Contoh';

module.exports = {
  PROJECT_NAME,
  RUN_TITLE,
  RUN_TITLE_UAT,
  SIT_RUN_PATTERN: new RegExp(`^SIT ${RUN_TITLE}`),
  UAT_RUN_PATTERN: new RegExp(`^UAT ${RUN_TITLE_UAT}`),

  // Profile Chrome & extension dipakai bareng lewat launchPersistentContext
  // -- session login tersimpan di sini (lihat auth/, gitignored).
  USER_DATA_DIR: path.join(__dirname, 'auth', 'chrome-profile'),
  EXTENSION_PATH: path.join(__dirname, 'zoom-extension'),

  // Ganti nilai "search" di URL ini sesuai project Qase kamu (atau hapus
  // parameter search-nya kalau mau lihat semua project aktif).
  PROJECTS_URL: 'https://app.qase.io/projects?page=1&perPage=50&search=YOUR_PROJECT_SEARCH&status=%5B"active"%5D',

  EVIDENCE_SIT_DIR: path.join(os.homedir(), 'Downloads', 'evidence-SIT'),
};
