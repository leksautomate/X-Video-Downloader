# ⬇️ X Video Downloader

[![Version](https://img.shields.io/badge/version-1.1.0-blue)](https://github.com/leksautomate/X-Video-Downloader)
[![Platform](https://img.shields.io/badge/platform-Chrome%20MV3-green)](https://developer.chrome.com/docs/extensions/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)
[![No ads](https://img.shields.io/badge/ads-none-brightgreen)]()
[![No tracking](https://img.shields.io/badge/tracking-none-brightgreen)]()

Download videos and GIFs from X (Twitter) in one click — straight from X's own servers. No third-party sites, no watermarks, no ads, no tracking, no accounts.

## ✨ Features

- **One-click downloads** — a download button appears on every video/GIF in your feed and on tweet pages. Best quality by default.
- **Quality picker** — every quality X serves (720p, 480p, …), selectable per video in the popup.
- **Thread batch download** — "Download all" grabs every video on the page at once, neatly organized into `XVideos/thread_<id>/`.
- **Provenance sidecar** — each download ships a `.json` citation file (tweet URL, author, post date, caption, quality, source URL). Built for journalists, researchers, and archivists.
- **Breakage-proof detection** — two independent strategies (API traffic sniffing + page HTML sweep) with automatic fallback, plus a **Rescan** button. X changes its layout often; this keeps working.
- **Toolbar popup** — lists all detected videos with thumbnails, quality pickers, and a live count badge on the icon.

## 📦 Install (2 minutes)

1. Download the [latest release](https://github.com/leksautomate/X-Video-Downloader/releases) (or clone this repo) and unzip it somewhere permanent — Chrome needs the folder to stay where it is.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `x-video-downloader` folder.
5. Pin it: click the puzzle-piece icon in the toolbar → pin **X Video Downloader**.

The only permission requested is `downloads`.

## 🚀 Usage

1. Go to [x.com](https://x.com) (log in if the video needs it — same as watching).
2. Scroll until the video loads. A round download button appears at the top-right of the video — click it for best quality.
3. Or click the extension icon: pick a quality per video, download one, or hit **Download all** for the whole thread.
4. Files land in `Downloads/XVideos/` as `xdl_<author>_<tweetid>_<quality>.mp4`, each next to its `.json` citation file.

> Videos are detected as they load — if the popup is empty, scroll the feed, open the tweet, or hit **Rescan**.

## 🔧 How it works

X's web app fetches video metadata (a `video_info.variants` list with direct MP4 URLs) from its own internal API. The extension observes that traffic inside the page, extracts every MP4 variant, and downloads your pick with Chrome's built-in downloader. If the API traffic isn't visible (cached pages, layout changes), it falls back to scanning the page HTML for direct `video.twimg.com` links. Nothing is uploaded anywhere and no external service is involved.

## 🔒 Privacy

- No data collection, no tracking, no analytics.
- No third-party servers — downloads come straight from X's CDN.
- Minimal permissions: only `downloads`. The extension only runs on x.com / twitter.com.
- Open source — audit it yourself.

## 🗂️ Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `lib.js` | Shared helpers: quality labels, filenames, citation files |
| `page-hook.js` | Runs in the page, sniffs X's API responses for video URLs |
| `content.js` | Injects the hook, HTML-sweep fallback, overlay buttons, batch logic |
| `background.js` | Service worker — performs downloads + citation files |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup (quality picker, download-all, rescan) |
| `overlay.css` | Download-button styling |
| `icons/` | Extension icons |

## 🤝 Contributing

Issues and pull requests are welcome. If X changes something and a video won't download, open an issue with the tweet URL and what the popup showed.

## ⚖️ License

MIT — see [LICENSE](LICENSE).

## ⚠️ Disclaimer

Independent project, not affiliated with X Corp. or Twitter. Intended for personal and fair use — only download videos you have the right to save, and respect creators' rights and copyright law.
