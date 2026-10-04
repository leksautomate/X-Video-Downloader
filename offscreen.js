/* X Video Downloader — offscreen worker (classic script).
 *
 * Runs the HD pipeline: fetch the HLS master playlist, pick the highest-
 * resolution rendition + its audio, download all fMP4 segments, remux into a
 * single MP4 with the built-in zero-dependency remuxer, and save it via
 * chrome.downloads.
 *
 * Classic scripts hls.js (global XHL) and hd-mux.js (global remuxFmp4) load
 * first in offscreen.html.
 */
'use strict';

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('playlist fetch failed (HTTP ' + r.status + ')');
  return await r.text();
}

async function fetchU8(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('segment fetch failed (HTTP ' + r.status + ')');
  return new Uint8Array(await r.arrayBuffer());
}

// Limited-concurrency segment downloader with progress ticks.
async function fetchAll(urls, onOne) {
  const out = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      out[idx] = await fetchU8(urls[idx]);
      onOne(idx + 1, urls.length);
    }
  }
  const n = Math.min(4, urls.length);
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function progress(key, stage, frac) {
  chrome.runtime.sendMessage({ type: 'xdl-hd-progress', key: key, stage: stage, frac: frac });
}

async function runJob(job) {
  const key = job.key;
  try {
    progress(key, 'playlist', 0.02);
    const master = XHL.parseMaster(await fetchText(job.hlsUrl), job.hlsUrl);
    const best = XHL.pickBest(master);
    if (!best) throw new Error('no video rendition found in stream playlist');

    const vPl = XHL.parseVariant(await fetchText(best.video.uri), best.video.uri);
    const aPl = best.audio
      ? XHL.parseVariant(await fetchText(best.audio.uri), best.audio.uri)
      : { initUri: null, segments: [] };
    if (!vPl.initUri || !vPl.segments.length) throw new Error('empty video stream');

    progress(key, 'segments', 0.05);
    const total = vPl.segments.length + aPl.segments.length;
    let done = 0;
    const tick = () => {
      done++;
      progress(key, 'segments', 0.05 + (done / total) * 0.6);
    };
    const [vInit, vSegs, aInit, aSegs] = await Promise.all([
      fetchU8(vPl.initUri),
      fetchAll(vPl.segments.map((s) => s.uri), tick),
      aPl.initUri ? fetchU8(aPl.initUri) : Promise.resolve(null),
      aPl.segments.length ? fetchAll(aPl.segments.map((s) => s.uri), tick) : Promise.resolve([])
    ]);

    const ab = await remuxFmp4(vInit, vSegs, aInit, aSegs,
      (stage, frac) => progress(key, stage === 'done' ? 'saving' : 'remux', 0.65 + frac * 0.3));

    const url = URL.createObjectURL(new Blob([ab], { type: 'video/mp4' }));
    await chrome.downloads.download({ url: url, filename: job.filename, conflictAction: 'uniquify', saveAs: false });
    if (job.sidecar && job.sidecar.filename && job.sidecar.json) {
      await chrome.downloads.download({
        url: 'data:application/json;charset=utf-8,' + encodeURIComponent(job.sidecar.json),
        filename: job.sidecar.filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    progress(key, 'done', 1);
    chrome.runtime.sendMessage({ type: 'xdl-hd-done', key: key, ok: true });
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'xdl-hd-done', key: key, ok: false,
      error: String((e && e.message) || e)
    });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'xdl-offscreen' && msg.action === 'xdl-hd-run' && msg.job) {
    runJob(msg.job);
  }
});
