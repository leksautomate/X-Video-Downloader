/* X Video Downloader — shared pure helpers (no browser APIs).
 * Loaded by the content script and the popup (see manifest / popup.html).
 * Also unit-tested in node (module.exports at the bottom).
 */
var XDL = (function () {
  'use strict';

  // Frame height parsed from WxH embedded in X CDN URLs
  // (e.g. .../pu/vid/avc1/1280x720/....mp4 -> 720). 0 when absent.
  function parseVariantDims(url) {
    var m = /(\d{3,4})x(\d{3,4})/.exec(url || '');
    if (!m) return 0;
    return Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // "720p"-style label for a variant. X embeds WxH in twimg URLs;
  // fall back to bitrate tiers when the URL carries no dimensions.
  function parseVariantLabel(url, bitrate) {
    var h = parseVariantDims(url);
    if (h) return h + 'p';
    var b = bitrate || 0;
    if (b >= 2000000) return 'HD';
    if (b >= 700000) return 'SD';
    return 'Low';
  }

  function sanitize(s) {
    return String(s)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  // folder: e.g. 'XVideos/' or 'XVideos/thread_123456/'
  function buildFileName(v, label, folder) {
    var base = 'xdl_' + (v.author || 'x') + '_' + (v.tweetId || v.key);
    if (label) base += '_' + label;
    return (folder || 'XVideos/') + sanitize(base) + '.mp4';
  }

  // Provenance sidecar: who posted it, when, where it came from.
  function buildSidecar(v, label, videoFilename) {
    var data = {
      tool: 'X Video Downloader',
      tweet_url: v.tweetId ? 'https://x.com/i/status/' + v.tweetId : null,
      author: v.author ? '@' + v.author : null,
      tweet_id: v.tweetId || null,
      posted_at: v.posted_at || null,
      caption: v.text || null,
      media_kind: v.kind || 'Video',
      quality: label || null,
      source_url: v.url || null,
      downloaded_at: new Date().toISOString()
    };
    return {
      filename: videoFilename.replace(/\.mp4$/i, '') + '.json',
      json: JSON.stringify(data, null, 2)
    };
  }

  // Best-first sort. Ranks by frame height FIRST, bitrate second:
  // bitrate alone misranks when X omits it or when a fat 720p outranks
  // a leaner 1080p. Also drops duplicate URLs. Returns a new array.
  function compareVariants(a, b) {
    var dh = parseVariantDims(b.url) - parseVariantDims(a.url);
    if (dh !== 0) return dh;
    return (b.bitrate || 0) - (a.bitrate || 0);
  }

  function sortVariants(variants) {
    var seen = {};
    var out = [];
    (variants || []).forEach(function (v) {
      if (!v || typeof v.url !== 'string' || seen[v.url]) return;
      seen[v.url] = true;
      out.push(v);
    });
    return out.sort(compareVariants);
  }

  return {
    parseVariantDims: parseVariantDims,
    parseVariantLabel: parseVariantLabel,
    buildFileName: buildFileName,
    buildSidecar: buildSidecar,
    compareVariants: compareVariants,
    sortVariants: sortVariants
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = XDL;
