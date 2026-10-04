/* X Video Downloader — page-world hook.
 *
 * Runs inside the page's own JavaScript world (injected by the content
 * script) so it can observe X's internal API traffic. Whenever an API
 * response contains video metadata (video_info.variants), the direct MP4
 * URLs are forwarded to the extension via window.postMessage.
 *
 * Privacy: everything stays in the browser. No data is sent anywhere else.
 */
(function () {
  'use strict';

  var reported = new Set();

  function isApiUrl(url) {
    return typeof url === 'string' && /^https:\/\/(x|twitter)\.com\/i\/api\//.test(url);
  }

  function getPath(obj, path) {
    var cur = obj;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // Rank variants by frame height first, bitrate second.
  // (Kept in sync with XDL.compareVariants in lib.js; the page world
  // cannot load lib.js, so the logic is duplicated here.)
  // Bitrate alone misranks when X omits it or a fat 720p outranks a
  // leaner 1080p — the old code picked the wrong "best" quality.
  function dimsHeight(url) {
    var m = /(\d{3,4})x(\d{3,4})/.exec(url || '');
    return m ? Math.min(parseInt(m[1], 10), parseInt(m[2], 10)) : 0;
  }

  function outranks(a, b) {
    var dh = dimsHeight(a.url) - dimsHeight(b.url);
    if (dh !== 0) return dh > 0;
    return (a.bitrate || 0) > (b.bitrate || 0);
  }

  // Pick the true highest-resolution direct MP4 variant
  // (plus the HLS URL as fallback info).
  // Returns { best, hls, all } where all = every MP4 variant, best-first.
  function pickVariants(variants) {
    var best = null;
    var hls = null;
    var all = [];
    if (!Array.isArray(variants)) return { best: best, hls: hls, all: all };
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i] || {};
      if (typeof v.url !== 'string') continue;
      if (v.content_type === 'video/mp4') {
        all.push({ url: v.url, bitrate: v.bitrate || 0 });
        if (!best || outranks(v, best)) best = v;
      } else if (v.content_type === 'application/x-mpegURL' && !hls) {
        hls = v.url;
      }
    }
    all.sort(function (a, b) {
      return outranks(a, b) ? -1 : (outranks(b, a) ? 1 : 0);
    });
    return { best: best, hls: hls, all: all };
  }

  function tweetContext(node) {
    var legacy = node && node.legacy;
    if (!legacy || legacy.id_str === undefined || legacy.id_str === null) return null;
    var screen =
      getPath(node, 'core.user_results.result.core.screen_name') ||
      getPath(node, 'core.user_results.result.legacy.screen_name') ||
      null;
    return {
      id: String(legacy.id_str),
      author: screen ? String(screen) : null,
      text: typeof legacy.full_text === 'string' ? legacy.full_text.slice(0, 140) : '',
      posted_at: typeof legacy.created_at === 'string' ? legacy.created_at : null
    };
  }

  function collectMedia(mediaArr, ctx, out) {
    for (var i = 0; i < mediaArr.length; i++) {
      var m = mediaArr[i];
      if (!m || !m.video_info) continue;
      var picked = pickVariants(m.video_info.variants);
      var key = m.id_str || m.id || m.media_url_https || (picked.best && picked.best.url);
      if (!key) continue;
      key = String(key);
      if (reported.has(key)) continue;
      reported.add(key);
      var size = (m.sizes && m.sizes.large) || {};
      out.push({
        key: key,
        kind: m.type === 'animated_gif' ? 'GIF' : 'Video',
        url: picked.best ? picked.best.url : null,
        variants: picked.all,
        hls: picked.hls,
        bitrate: picked.best ? picked.best.bitrate || 0 : 0,
        width: size.w || 0,
        height: size.h || 0,
        thumb: m.media_url_https || null,
        tweetId: ctx ? ctx.id : null,
        author: ctx ? ctx.author : null,
        text: ctx ? ctx.text : '',
        posted_at: ctx ? ctx.posted_at : null,
        via: 'api'
      });
    }
  }

  function scan(node, ctx, out) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) scan(node[i], ctx, out);
      return;
    }
    var c = tweetContext(node) || ctx;
    var media = getPath(node, 'legacy.extended_entities.media');
    if (Array.isArray(media)) collectMedia(media, c, out);
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) scan(node[k], c, out);
    }
  }

  function handleData(data) {
    try {
      var out = [];
      scan(data, null, out);
      if (out.length) {
        window.postMessage({ source: 'xdl-page-hook', type: 'xdl-videos', videos: out }, '*');
      }
    } catch (e) { /* never break the page */ }
  }

  // --- fetch wrapper (X's web app loads timelines through fetch) ---
  if (typeof window !== 'undefined' && window.fetch) {
    (function () {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url);
        var p = origFetch.apply(this, arguments);
        if (isApiUrl(url) && p && typeof p.then === 'function') {
          p.then(function (res) {
            try {
              if (res && typeof res.clone === 'function') {
                res.clone().json().then(handleData).catch(function () {});
              }
            } catch (e) {}
          }).catch(function () {});
        }
        return p;
      };
    })();
  }

  // --- XHR wrapper (covers older code paths) ---
  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
    (function () {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this._xdl_url = url; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          this.addEventListener('load', function () {
            try {
              if (!isApiUrl(this._xdl_url)) return;
              var data = null;
              if (typeof this.response === 'string') {
                data = JSON.parse(this.response);
              } else if (this.response && typeof this.response === 'object') {
                data = this.response;
              }
              if (data) handleData(data);
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    })();
  }
})();
