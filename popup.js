/* X Video Downloader — popup.
 *
 * Lists videos detected on the active tab with a per-video quality picker
 * (progressive MP4s + an HD option built from the HLS stream when it offers
 * higher resolution), plus Download-all (thread batch) and Rescan actions.
 * Shows live progress while an HD file is being assembled.
 */
(function () {
  'use strict';

  var listEl, countEl, dlAllBtn, rescanBtn, activeTabId = null;
  var rowState = []; // [{ v, select, dlBtn, progWrap, progBar, progPct, hd: {height,label} | null }]
  var hdProbeCache = {}; // key -> {height, width} | null

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function metaLine(v) {
    var bits = [];
    bits.push(v.kind === 'GIF' ? 'GIF' : 'Video');
    if (v.via === 'html-sweep') bits.push('page scan');
    if (v.author) bits.push('@' + v.author);
    return bits.join(' · ');
  }

  function variantsOf(v) {
    if (Array.isArray(v.variants) && v.variants.length) return v.variants;
    return [{ url: v.url, bitrate: v.bitrate || 0 }];
  }

  function progHeightOf(v) {
    var m = /^(\d+)p$/.exec(XDL.parseVariantLabel(v.url, v.bitrate));
    return m ? parseInt(m[1], 10) : 0;
  }

  function selectedOf(st) {
    if (st.select.value === 'hd' && st.hd) {
      return { url: null, label: st.hd.label, hd: true };
    }
    var list = variantsOf(st.v);
    var idx = parseInt(st.select.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= list.length) idx = 0;
    var vn = list[idx];
    var opt = st.select.options[st.select.selectedIndex];
    return {
      url: vn.url,
      label: opt ? opt.text : XDL.parseVariantLabel(vn.url, vn.bitrate),
      hd: false
    };
  }

  // Ask the HLS master playlist how high it goes; offer HD if it beats progressive.
  function probeHd(st) {
    var v = st.v;
    if (!v.hls) return;
    if (Object.prototype.hasOwnProperty.call(hdProbeCache, v.key)) {
      applyHd(st, hdProbeCache[v.key]);
      return;
    }
    fetch(v.hls).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text();
    }).then(function (text) {
      var best = XHL.pickBest(XHL.parseMaster(text, v.hls));
      var info = best ? { height: best.video.height, width: best.video.width } : null;
      hdProbeCache[v.key] = info;
      applyHd(st, info);
    }).catch(function () {
      hdProbeCache[v.key] = null;
    });
  }

  function applyHd(st, info) {
    if (!info || !info.height) return;
    if (info.height <= progHeightOf(st.v)) return; // stream isn't better than progressive
    var label = Math.min(info.width, info.height) + 'p HD';
    st.hd = { height: info.height, label: label };
    var o = document.createElement('option');
    o.value = 'hd';
    o.textContent = label;
    st.select.insertBefore(o, st.select.firstChild);
    st.select.value = 'hd'; // HD is the point — select it by default
  }

  function setProgress(st, frac, text) {
    st.progWrap.classList.add('on');
    st.progBar.style.width = Math.round(frac * 100) + '%';
    st.progPct.textContent = text || Math.round(frac * 100) + '%';
  }

  function startHd(st) {
    var v = st.v;
    var label = st.hd.label.replace(/\s+/g, '-'); // e.g. "1080p-HD"
    var filename = XDL.buildFileName(v, label, 'XVideos/');
    var sidecar = XDL.buildSidecar(
      { tweetId: v.tweetId, author: v.author, text: v.text, kind: v.kind,
        posted_at: v.posted_at, url: v.hls },
      label, filename, { method: 'hls-remux' }
    );
    st.dlBtn.disabled = true;
    st.dlBtn.textContent = 'Building…';
    setProgress(st, 0, 'starting…');
    chrome.runtime.sendMessage({
      action: 'xdl-hd-start',
      job: { key: v.key, hlsUrl: v.hls, filename: filename, sidecar: sidecar }
    }, function (res) {
      if (chrome.runtime.lastError || !res || !res.ok) {
        finishHd(v.key, false, (res && res.error) || 'could not start HD worker');
      }
    });
  }

  function findRow(key) {
    for (var i = 0; i < rowState.length; i++) {
      if (rowState[i].v.key === key) return rowState[i];
    }
    return null;
  }

  function updateHdProgress(key, stage, frac) {
    var st = findRow(key);
    if (!st) return;
    var names = { playlist: 'reading stream…', segments: 'fetching pieces…', remux: 'assembling…', saving: 'saving…', done: 'done' };
    setProgress(st, frac, names[stage] || (Math.round(frac * 100) + '%'));
  }

  function finishHd(key, ok, error) {
    var st = findRow(key);
    if (!st) return;
    st.dlBtn.disabled = false;
    if (ok) {
      setProgress(st, 1, 'saved ✓');
      st.dlBtn.textContent = 'Download';
      setTimeout(function () { st.progWrap.classList.remove('on'); }, 4000);
    } else {
      setProgress(st, 1, 'failed');
      st.progPct.textContent = 'HD failed — try a quality below';
      st.dlBtn.textContent = 'Download';
      if (error) st.progPct.title = error;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === 'xdl-hd-progress') updateHdProgress(msg.key, msg.stage, msg.frac);
    else if (msg.type === 'xdl-hd-done') finishHd(msg.key, msg.ok, msg.error);
  });

  function render(videos) {
    var usable = (videos || []).filter(function (v) { return v && v.url; });
    rowState = [];
    countEl.textContent = usable.length === 1 ? '1 video detected' : usable.length + ' videos detected';
    dlAllBtn.style.display = usable.length > 1 ? '' : 'none';
    if (!usable.length) {
      listEl.innerHTML = '<div class="empty">No videos detected yet.<br>Scroll the feed, open a tweet with video,<br>or hit Rescan — then reopen this panel.</div>';
      return;
    }
    listEl.innerHTML = '';
    usable.forEach(function (v) {
      var row = document.createElement('div');
      row.className = 'row';
      var thumb = v.thumb
        ? '<img class="thumb" src="' + esc(v.thumb) + '" alt="">'
        : '<div class="thumb thumb--none">&#9654;</div>';
      var tweetLink = v.tweetId
        ? ' <a class="tweetlink" href="https://x.com/i/status/' + esc(v.tweetId) + '" target="_blank" rel="noopener">View tweet &#8599;</a>'
        : '';
      row.innerHTML =
        thumb +
        '<div class="meta"><div class="t">' + esc(v.text || (v.author ? '@' + v.author : 'X video')) + '</div>' +
        '<div class="s">' + esc(metaLine(v)) + tweetLink + '</div>' +
        '<div class="hdprog"><div class="hdbar"></div></div><div class="hdpct"></div></div>' +
        '<div class="ops"><select class="qpick"></select><button type="button">Download</button></div>';

      var sel = row.querySelector('.qpick');
      variantsOf(v).forEach(function (vn, i) {
        var o = document.createElement('option');
        o.value = i;
        o.textContent = XDL.parseVariantLabel(vn.url, vn.bitrate);
        sel.appendChild(o);
      });
      var st = {
        v: v, select: sel,
        dlBtn: row.querySelector('.ops button'),
        progWrap: row.querySelector('.hdprog'),
        progBar: row.querySelector('.hdbar'),
        progPct: row.querySelector('.hdpct'),
        hd: null
      };
      rowState.push(st);

      st.dlBtn.addEventListener('click', function () {
        var picked = selectedOf(st);
        if (picked.hd) {
          startHd(st);
          return;
        }
        chrome.tabs.sendMessage(activeTabId, {
          action: 'xdl-download-one', key: v.key, url: picked.url, label: picked.label
        });
        var b = this;
        b.textContent = 'Saving…';
        setTimeout(function () { b.textContent = 'Download'; }, 2500);
      });
      listEl.appendChild(row);
      probeHd(st); // async — adds the HD option when the stream beats progressive
    });
  }

  function requestList() {
    chrome.tabs.sendMessage(activeTabId, { action: 'xdl-list' }, function (res) {
      if (chrome.runtime.lastError || !res) {
        listEl.innerHTML = '<div class="empty">Could not reach the page.<br>Reload x.com and try again.</div>';
        return;
      }
      render(res.videos || []);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    listEl = document.getElementById('list');
    countEl = document.getElementById('count');
    dlAllBtn = document.getElementById('dlAll');
    rescanBtn = document.getElementById('rescan');

    dlAllBtn.addEventListener('click', function () {
      var items = rowState.map(function (st) {
        var picked = selectedOf(st);
        return { key: st.v.key, url: picked.url, label: picked.label, hd: picked.hd, hls: st.v.hls };
      });
      // Progressive items go the fast path; HD items build from the stream.
      items.forEach(function (it) {
        if (it.hd) {
          var st = findRow(it.key);
          if (st) startHd(st);
        } else {
          chrome.tabs.sendMessage(activeTabId, {
            action: 'xdl-download-one', key: it.key, url: it.url, label: it.label
          });
        }
      });
      dlAllBtn.textContent = 'Saving ' + items.length + '…';
      setTimeout(function () { dlAllBtn.textContent = 'Download all'; }, 3000);
    });

    rescanBtn.addEventListener('click', function () {
      rescanBtn.textContent = 'Scanning…';
      chrome.tabs.sendMessage(activeTabId, { action: 'xdl-rescan' }, function (res) {
        rescanBtn.textContent = 'Rescan';
        if (!chrome.runtime.lastError && res) render(res.videos || []);
      });
    });

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !/^https:\/\/(www\.)?(x|twitter)\.com\//.test(tab.url || '')) {
        countEl.textContent = '';
        dlAllBtn.style.display = 'none';
        rescanBtn.style.display = 'none';
        listEl.innerHTML = '<div class="empty">Open x.com in this tab<br>to detect videos.</div>';
        return;
      }
      activeTabId = tab.id;
      requestList();
    });
  });
})();
