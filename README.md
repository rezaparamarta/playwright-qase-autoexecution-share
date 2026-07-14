# playwright-qase-autoexecution

Kumpulan script Playwright untuk mengotomatiskan alur kerja eksekusi test case di Qase:
login/session Qase, menyalin evidence hasil eksekusi dari suite SIT ke UAT, membandingkan
daftar case antar run, dan beberapa tool debug/inspeksi case.

## Author

**Reza Paramarta** — [github.com/rezaparamarta](https://github.com/rezaparamarta)

Project ini dibuat dan dikelola oleh Reza Paramarta. Kalau kamu mendapat/menggunakan
salinan kode ini, mohon tetap cantumkan atribusi di atas.

## Cara Menjalankan (untuk pemula)

Panduan ini mengasumsikan kamu belum pernah pakai Node.js atau Playwright sama sekali.

### 1. Install Node.js

Download dan install dari [nodejs.org](https://nodejs.org) (pilih versi **LTS**). Setelah
install, buka terminal (PowerShell di Windows, atau Terminal di Mac) dan cek dengan:

```
node --version
```

Kalau muncul nomor versi (misal `v20.x.x`), berarti sudah berhasil.

### 2. Download project ini

Kalau sudah punya foldernya (misalnya lewat `git clone` atau extract dari ZIP), buka
terminal lalu masuk ke folder project:

```
cd path/ke/folder/playwright-qase-autoexecution-share
```

### 3. Install semua dependency

Ini akan mendownload library yang dipakai project (Playwright, dll):

```
npm install
```

Lalu install browser yang dipakai Playwright untuk otomatisasi (Chromium):

```
npx playwright install chromium
```

### 4. Sesuaikan konfigurasi

Buka file `config.js`, lalu isi `PROJECT_NAME`, `RUN_TITLE`, `RUN_TITLE_UAT`, dan
`PROJECTS_URL` dengan nilai project/run Qase milikmu sendiri (nilai bawaan di file ini
cuma placeholder generik, wajib diganti supaya script bisa jalan). Nilai `SUITE_TEXT`
di `main.js`, `compare-suite.js`, `debug-case354.js`, dan `inspect-case.js` juga perlu
diganti sesuai nama suite/case di project Qase kamu.

### 5. Login ke Qase (cuma perlu sekali)

Jalankan:

```
node login.js
```

Sebuah browser Chrome akan terbuka otomatis. Login manual seperti biasa (termasuk
SSO/2FA kalau ada). Setelah dashboard Qase terlihat, script akan otomatis menyimpan
session login ke folder `auth/` dan browser tertutup sendiri — tidak perlu login lagi
tiap kali menjalankan script lain, selama folder `auth/` tidak dihapus.

### 6. Jalankan script utama

Setelah login tersimpan, jalankan proses penyalinan evidence SIT → UAT dengan:

```
node main.js
```

Browser akan terbuka lagi (kali ini otomatis, tanpa perlu login ulang) dan proses
berjalan sendiri. Ikuti output di terminal untuk memantau progress.

Script lain (`compare-suite.js`, `debug-case354.js`, `inspect-case.js`) dijalankan
dengan cara yang sama, contoh: `node compare-suite.js`.

### Catatan/Troubleshooting

- Kalau muncul error terkait browser tidak ditemukan, ulangi langkah `npx playwright install chromium`.
- Kalau sesi login sudah kedaluwarsa/logout, hapus folder `auth/` lalu jalankan ulang `node login.js`.
- Folder `node_modules/`, `auth/`, dan `downloads/` sengaja tidak ikut ter-share/ter-commit (lihat `.gitignore`) karena isinya dependency dan data sesi pribadi, bukan bagian dari kode.

## Scripts

- `login.js` — login manual sekali (termasuk SSO/2FA), simpan session ke `auth/qase-storage.json`.
- `main.js` — menyalin evidence hasil eksekusi SIT ke UAT dan menandai case Passed di Qase.
- `compare-suite.js` — diagnostik: membandingkan daftar case antara run SIT dan UAT.
- `debug-case354.js`, `inspect-case.js` — tool debug/inspeksi case satu-kali.
- `config.js` — konfigurasi bersama (project/run Qase) yang dipakai script-script di atas.
- `zoom-extension/` — Chrome extension kecil untuk auto-zoom tab app.qase.io.
