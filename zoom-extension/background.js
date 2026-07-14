// Author: Reza Paramarta (https://github.com/rezaparamarta)
//
// Auto-zoom setiap tab yang buka app.qase.io ke 67% (level zoom asli Chrome,
// bukan CSS hack) lewat chrome.tabs.setZoom -- API resmi extension, jadi gak
// gantung ke struktur internal Preferences Chrome yang gak terdokumentasi.
const ZOOM_FACTOR = 2 / 3; // ~67%, sama kayak preset zoom asli Chrome

function applyZoom(tabId, url) {
  if (url && url.startsWith('https://app.qase.io')) {
    chrome.tabs.setZoom(tabId, ZOOM_FACTOR);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    applyZoom(tabId, tab.url);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url) {
    applyZoom(tab.id, tab.url);
  }
});
