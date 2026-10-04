/* X Video Downloader — popup.
 * Lists videos detected on the active tab with a per-video quality picker,
 * plus Download-all (thread batch) and Rescan actions.
 */
(function () {
  'use strict';

  var listEl, countEl, dlAllBtn, rescanBtn, activeTabId = null;
  var rowState = []; // [{ v, select }]

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

  function selectedOf(st) {
    var list = variantsOf(st.v);
    var idx = parseInt(st.select.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= list.length) idx = 0;
    var vn = list[idx];
    return {
      url: vn.url,
      label: st.select.options[st.select.selectedIndex]
        ? st.select.options[st.select.selectedIndex].text
        : XDL.parseVariantLabel(vn.url, vn.bitrate)
    };
  }

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
        '<div class="s">' + esc(metaLine(v)) + tweetLink + '</div></div>' +
        '<div class="ops"><select class="qpick"></select><button type="button">Download</button></div>';

      var sel = row.querySelector('.qpick');
      variantsOf(v).forEach(function (vn, i) {
        var o = document.createElement('option');
        o.value = i;
        o.textContent = XDL.parseVariantLabel(vn.url, vn.bitrate);
        sel.appendChild(o);
      });
      var st = { v: v, select: sel };
      rowState.push(st);

      row.querySelector('.ops button').addEventListener('click', function () {
        var picked = selectedOf(st);
        chrome.tabs.sendMessage(activeTabId, {
          action: 'xdl-download-one', key: v.key, url: picked.url, label: picked.label
        });
        var b = this;
        b.textContent = 'Saving…';
        setTimeout(function () { b.textContent = 'Download'; }, 2500);
      });
      listEl.appendChild(row);
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
        return { key: st.v.key, url: picked.url, label: picked.label };
      });
      chrome.tabs.sendMessage(activeTabId, { action: 'xdl-download-all', items: items });
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
