/* X Video Downloader — HLS (m3u8) playlist parser.
 * Pure logic, no browser APIs. Used by the HD pipeline to find the highest-
 * resolution rendition and its audio track. Also unit-tested in node.
 */
var XHL = (function () {
  'use strict';

  function resolveUrl(rel, base) {
    try { return new URL(rel, base).href; }
    catch (e) { return rel; }
  }

  // Parse `KEY=VAL,KEY2="quoted val"` attribute lists.
  function parseAttrs(attrStr) {
    var attrs = {};
    var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m;
    while ((m = re.exec(attrStr)) !== null) {
      var v = m[2];
      if (v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
      attrs[m[1]] = v;
    }
    return attrs;
  }

  // Master playlist -> { variants: [...], audios: [...] } with absolute URLs.
  function parseMaster(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var variants = [];
    var audios = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        var uri = (lines[++i] || '').trim();
        if (!uri || uri.charAt(0) === '#') continue;
        var res = attrs.RESOLUTION ? attrs.RESOLUTION.split('x') : null;
        variants.push({
          uri: resolveUrl(uri, baseUrl),
          bandwidth: parseInt(attrs.BANDWIDTH || '0', 10) || 0,
          width: res ? parseInt(res[0], 10) || 0 : 0,
          height: res ? parseInt(res[1], 10) || 0 : 0,
          audioGroup: attrs.AUDIO || null,
          codecs: attrs.CODECS || ''
        });
      } else if (line.indexOf('#EXT-X-MEDIA:') === 0) {
        var a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
        if (a.TYPE === 'AUDIO') {
          audios.push({
            groupId: a['GROUP-ID'] || '',
            uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
            name: a.NAME || '',
            channels: a.CHANNELS || '',
            isDefault: a.DEFAULT === 'YES'
          });
        }
      }
    }
    return { variants: variants, audios: audios };
  }

  // Highest-resolution video variant + its audio rendition.
  function pickBest(master) {
    var withRes = master.variants.filter(function (v) { return v.height > 0; });
    var pool = withRes.length ? withRes : master.variants;
    pool.sort(function (a, b) {
      return (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth);
    });
    var video = pool[0];
    if (!video) return null;
    var audio = null;
    if (video.audioGroup) {
      var cands = master.audios.filter(function (a) {
        return a.groupId === video.audioGroup && a.uri;
      });
      cands.sort(function (a, b) {
        return ((b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)) ||
          (parseInt(a.channels || '2', 10) - parseInt(b.channels || '2', 10));
      });
      audio = cands[0] || null;
    }
    if (!audio) {
      var anyA = master.audios.filter(function (a) { return a.uri; });
      audio = anyA[0] || null;
    }
    return { video: video, audio: audio };
  }

  // Media playlist -> { initUri, segments: [{uri, duration}] } with absolute URLs.
  function parseVariant(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var initUri = null;
    var segments = [];
    var dur = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-MAP:') === 0) {
        var a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
        if (a.URI) initUri = resolveUrl(a.URI, baseUrl);
      } else if (line.indexOf('#EXTINF:') === 0) {
        dur = parseFloat(line.slice(8).split(',')[0]) || 0;
      } else if (line && line.charAt(0) !== '#') {
        segments.push({ uri: resolveUrl(line, baseUrl), duration: dur });
        dur = 0;
      }
    }
    return { initUri: initUri, segments: segments };
  }

  return {
    parseMaster: parseMaster,
    parseVariant: parseVariant,
    pickBest: pickBest,
    resolveUrl: resolveUrl
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = XHL;
