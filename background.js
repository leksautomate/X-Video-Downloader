/* X Video Downloader — background service worker.
 * Performs the actual file downloads via chrome.downloads, plus the
 * provenance sidecar (.json citation file) that ships with every video.
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.action === 'xdl-download' && msg.url) {
    chrome.downloads.download(
      {
        url: msg.url,
        filename: msg.filename || 'x-video.mp4',
        conflictAction: 'uniquify',
        saveAs: false
      },
      function (downloadId) {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        // Provenance sidecar: tiny JSON citation file next to the video.
        if (msg.sidecar && msg.sidecar.filename && msg.sidecar.json) {
          chrome.downloads.download({
            url: 'data:application/json;charset=utf-8,' + encodeURIComponent(msg.sidecar.json),
            filename: msg.sidecar.filename,
            conflictAction: 'uniquify',
            saveAs: false
          });
        }
        sendResponse({ ok: true, downloadId: downloadId });
      }
    );
    return true; // async response
  }
});
