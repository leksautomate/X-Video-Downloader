/* X Video Downloader — background service worker.
 *
 * - xdl-download:    direct MP4 (+ provenance sidecar) via chrome.downloads.
 * - xdl-hd-start:    ensures the offscreen worker exists and forwards the job;
 *                    the offscreen document fetches HLS segments, remuxes them
 *                    to a high-resolution MP4, and downloads it.
 */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Fetch HLS video segments and remux them into a high-resolution MP4'
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  if (msg.action === 'xdl-download' && msg.url) {
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

  if (msg.action === 'xdl-hd-start' && msg.job) {
    ensureOffscreen()
      .then(function () {
        return chrome.runtime.sendMessage({ target: 'xdl-offscreen', action: 'xdl-hd-run', job: msg.job });
      })
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true; // async response
  }
});
