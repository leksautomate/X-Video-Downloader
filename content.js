/* X Video Downloader — content script (extension's isolated world).
 *
 * - Injects page-hook.js into the page so it can see X's API traffic (strategy A).
 * - Falls back to sweeping article HTML for direct twimg MP4 URLs (strategy B).
 * - Overlays a download button on each detected video player.
 * - Serves the popup: video list, single/batch downloads, rescan.
 */
(function () {
  'use strict';

  // Inject the page-world hook.
  try {
    var hook = document.createElement('script');
    hook.src = chrome.runtime.getURL('page-hook.js');
    hook.addEventListener('load', function () { hook.remove(); });
    (document.head || document.documentElement).appendChild(hook);
  } catch (e) {}

  var byKey = new Map();
  var byTweet = new Map();
  var overlayTimer = 0;

  // Videos on a tweet page belong to that thread; otherwise it's a generic batch.
  function threadFolder() {
    var m = location.href.match(/\/status\/(\d+)/);
    return m ? 'XVideos/thread_' + m[1] + '/' : 'XVideos/batch/';
  }

  function addVideo(v) {
    if (!v || !v.key || byKey.has(v.key)) return false;
    if (Array.isArray(v.variants) && v.variants.length) {
      v.variants = XDL.sortVariants(v.variants);
      if (!v.url) v.url = v.variants[0].url;
    } else if (v.url) {
      v.variants = [{ url: v.url, bitrate: v.bitrate || 0 }];
    } else {
      return false; // nothing downloadable
    }
    byKey.set(v.key, v);
    if (v.tweetId) {
      if (!byTweet.has(v.tweetId)) byTweet.set(v.tweetId, []);
      byTweet.get(v.tweetId).push(v);
    }
    return true;
  }

  function sendDownload(v, url, label, folder) {
    var effLabel = label || XDL.parseVariantLabel(url, v.bitrate);
    var filename = XDL.buildFileName(v, effLabel, folder || 'XVideos/');
    var sidecar = XDL.buildSidecar(
      { tweetId: v.tweetId, author: v.author, text: v.text, kind: v.kind,
        posted_at: v.posted_at, url: url },
      effLabel, filename
    );
    chrome.runtime.sendMessage(
      { action: 'xdl-download', url: url, filename: filename, sidecar: sidecar },
      function (res) {
        // Don't swallow a failed download: flash an error badge so the
        // user knows the save didn't happen (previously fire-and-forget).
        if (res && res.ok === false) {
          try {
            chrome.action.setBadgeBackgroundColor({ color: '#c00' });
            chrome.action.setBadgeText({ text: 'ERR' });
            setTimeout(updateBadge, 4000);
          } catch (e) {}
        }
      }
    );
  }

  function downloadOne(v, url, label) {
    if (!v) return;
    sendDownload(v, url || v.url, label, 'XVideos/');
  }

  // Batch: items = [{key, url, label}]; staggered to stay friendly.
  function downloadAll(items) {
    var folder = threadFolder();
    (items || []).forEach(function (it, i) {
      setTimeout(function () {
        var v = byKey.get(it.key);
        if (!v) return;
        sendDownload(v, it.url || v.url, it.label, folder);
      }, i * 400);
    });
  }

  // --- Fallback strategy B: sweep each article's HTML for direct twimg MP4s.
  // Catches videos the API hook missed (e.g. server-rendered or cached pages).
  function htmlSweep() {
    var found = 0;
    var articles = document.querySelectorAll('article');
    for (var ai = 0; ai < articles.length; ai++) {
      var article = articles[ai];
      var tid = tweetIdFromArticle(article);
      var html = article.innerHTML || '';
      var re = /https:\/\/video\.twimg\.com\/[^"'\\\s<>]+\.mp4/gi;
      var m;
      var seenInArticle = {};
      while ((m = re.exec(html)) !== null) {
        var url = m[0];
        if (seenInArticle[url] || byKey.has(url)) continue;
        seenInArticle[url] = true;
        if (addVideo({
          key: url, kind: 'Video', url: url,
          variants: [{ url: url, bitrate: 0 }], bitrate: 0,
          width: 0, height: 0, thumb: null,
          tweetId: tid, author: null, text: '', posted_at: null,
          via: 'html-sweep'
        })) found++;
      }
    }
    return found;
  }

  function tweetIdFromArticle(article) {
    var a = article.querySelector('a[href*="/status/"]');
    if (!a) return null;
    var m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  // Player detection with fallback: data-testid first, then any <video>'s parent.
  function findPlayers(article) {
    var p = article.querySelectorAll('[data-testid="videoPlayer"],[data-testid="videoComponent"]');
    if (p.length) return Array.prototype.slice.call(p);
    var vids = article.querySelectorAll('video');
    var out = [];
    for (var i = 0; i < vids.length; i++) {
      var par = vids[i].parentElement;
      if (par && out.indexOf(par) === -1) out.push(par);
    }
    return out;
  }

  var DL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

  function overlayPass() {
    if (!byTweet.size) return;
    var articles = document.querySelectorAll('article');
    for (var ai = 0; ai < articles.length; ai++) {
      (function (article) {
        var tid = tweetIdFromArticle(article);
        if (!tid) return;
        var vids = byTweet.get(tid);
        if (!vids || !vids.length) return;
        var players = findPlayers(article);
        var idx = 0;
        for (var pi = 0; pi < players.length; pi++) {
          var player = players[pi];
          if (player.closest('article') !== article) continue; // quoted tweet's own article
          if (player.querySelector('.xdl-dl-btn')) continue;
          var v = vids[idx] || vids[0];
          idx++;
          if (!v || !v.url) continue;
          player.classList.add('xdl-player');
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'xdl-dl-btn';
          btn.title = 'Download ' + (v.kind === 'GIF' ? 'GIF' : 'video') +
            ' (' + XDL.parseVariantLabel(v.url, v.bitrate) + ')';
          btn.innerHTML = DL_SVG;
          btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            downloadOne(v);
          });
          player.appendChild(btn);
        }
      })(articles[ai]);
    }
  }

  function scheduleOverlayPass() {
    if (overlayTimer) return;
    overlayTimer = setTimeout(function () {
      overlayTimer = 0;
      try { overlayPass(); } catch (e) {}
    }, 250);
  }

  function rescan() {
    var swept = 0;
    try { swept = htmlSweep(); } catch (e) {}
    try { overlayPass(); } catch (e) {}
    return swept;
  }

  function updateBadge() {
    try {
      var n = 0;
      byKey.forEach(function (v) { if (v.url) n++; });
      chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
      chrome.action.setBadgeText({ text: n ? String(n) : '' });
    } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data) return;
    var d = ev.data;
    if (d.source !== 'xdl-page-hook' || d.type !== 'xdl-videos' || !Array.isArray(d.videos)) return;
    var added = false;
    for (var i = 0; i < d.videos.length; i++) {
      if (addVideo(d.videos[i])) added = true;
    }
    if (added) {
      scheduleOverlayPass();
      updateBadge();
    }
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.action === 'xdl-list') {
      sendResponse({ videos: Array.from(byKey.values()) });
    } else if (msg.action === 'xdl-download-one' && msg.key) {
      downloadOne(byKey.get(msg.key), msg.url, msg.label);
      sendResponse({ ok: true });
    } else if (msg.action === 'xdl-download-all') {
      downloadAll(msg.items);
      sendResponse({ ok: true });
    } else if (msg.action === 'xdl-rescan') {
      var swept = rescan();
      updateBadge();
      sendResponse({ ok: true, swept: swept, videos: Array.from(byKey.values()) });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleOverlayPass);
  } else {
    scheduleOverlayPass();
  }
  try {
    new MutationObserver(scheduleOverlayPass).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
