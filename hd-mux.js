/* X Video Downloader — minimal fMP4 → MP4 remuxer (zero dependencies).
 *
 * Merges fragmented-MP4 init/segments (the way X serves video over HLS:
 * separate AVC video + AAC audio tracks) into a single plain MP4.
 *
 * Pure logic, no browser APIs: runs in node (tests) and in the extension's
 * offscreen document. Validated with ffprobe + a full decode pass.
 */

'use strict';

// ---------- byte helpers ----------
function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function i32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; }
function u64(n) {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Math.floor(n / 4294967296));
  dv.setUint32(4, n >>> 0);
  return b;
}
function ascii(s) { return new TextEncoder().encode(s); }
function asciiAt(u8, pos, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[pos + i]);
  return s;
}
function box(type, ...payloads) {
  const body = concatBytes(payloads);
  const size = 8 + body.length;
  if (size <= 0xffffffff) return concatBytes([u32(size), ascii(type), body]);
  return concatBytes([u32(1), ascii(type), u64(size), body]); // large size
}
function fullBox(type, version, flags, ...payloads) {
  return box(type, new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]),
    ...payloads);
}
function dvAt(u8, pos) { return new DataView(u8.buffer, u8.byteOffset + pos); }

// ---------- box parsing ----------
function parseBoxes(u8, start, end) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    const dv = dvAt(u8, p);
    let size = dv.getUint32(0);
    const type = asciiAt(u8, p + 4, 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); header = 16; }
    else if (size === 0) { size = end - p; }
    if (size < 8 || p + size > end + 1) break; // corrupt guard
    boxes.push({ type, size, start: p, payloadStart: p + header, payloadEnd: p + size });
    p += size;
  }
  return boxes;
}
function kids(u8, b) { return parseBoxes(u8, b.payloadStart, b.payloadEnd); }
function one(u8, b, type) {
  const ks = kids(u8, b);
  for (const k of ks) if (k.type === type) return k;
  return null;
}
function topBoxes(u8) { return parseBoxes(u8, 0, u8.length); }
function topOne(u8, type) {
  for (const b of topBoxes(u8)) if (b.type === type) return b;
  return null;
}
function sliceBox(u8, b) { return u8.slice(b.start, b.start + b.size); }
function findPath(u8, types) {
  let start = 0, end = u8.length, node = null;
  for (const t of types) {
    node = null;
    for (const b of parseBoxes(u8, start, end)) {
      if (b.type === t) { node = b; break; }
    }
    if (!node) return null;
    start = node.payloadStart; end = node.payloadEnd;
  }
  return node;
}

// ---------- init segment parsing ----------
function parseInit(u8) {
  const moov = topOne(u8, 'moov');
  if (!moov) throw new Error('hd-mux: no moov in init segment');
  const tracks = [];
  for (const trak of kids(u8, moov)) {
    if (trak.type !== 'trak') continue;
    const mdia = one(u8, trak, 'mdia');
    const hdlr = one(u8, mdia, 'hdlr');
    const handler = asciiAt(u8, hdlr.payloadStart + 8, 4);
    const mdhd = one(u8, mdia, 'mdhd');
    const timescale = dvAt(u8, mdhd.payloadStart + 12).getUint32(0);
    const minf = one(u8, mdia, 'minf');
    const stbl = one(u8, minf, 'stbl');
    const stsdBox = one(u8, stbl, 'stsd');
    // stsd is a FullBox: skip version/flags (4) + entry_count (4) to reach entries.
    const entry = parseBoxes(u8, stsdBox.payloadStart + 8, stsdBox.payloadEnd)[0];
    const entryType = entry.type;
    // Child config boxes (avcC/esds) sit after the entry's fixed fields:
    // 78 bytes for visual entries, 28 for audio entries.
    const fixedLen = handler === 'vide' ? 78 : 28;
    let configBox = null;
    let width = 0, height = 0, channels = 0, sampleRate = 0;
    for (const cb of parseBoxes(u8, entry.payloadStart + fixedLen, entry.payloadEnd)) {
      if (cb.type === 'avcC' || cb.type === 'hvcC' || cb.type === 'esds') { configBox = cb; break; }
    }
    if (!configBox) throw new Error('hd-mux: no avcC/hvcC/esds in init');
    if (handler === 'vide') {
      width = dvAt(u8, entry.payloadStart + 24).getUint16(0);
      height = dvAt(u8, entry.payloadStart + 26).getUint16(0);
    } else {
      channels = dvAt(u8, entry.payloadStart + 16).getUint16(0);
      sampleRate = dvAt(u8, entry.payloadStart + 24).getUint32(0) / 65536;
    }
    tracks.push({
      handler, timescale, entryType,
      configBytes: sliceBox(u8, configBox),
      width, height, channels, sampleRate: Math.round(sampleRate)
    });
  }
  if (!tracks.length) throw new Error('hd-mux: no tracks in init segment');
  return tracks;
}

// ---------- media segment parsing ----------
function parseSegment(u8) {
  const moof = topOne(u8, 'moof');
  const mdat = topOne(u8, 'mdat');
  if (!moof || !mdat) throw new Error('hd-mux: segment missing moof/mdat');
  const samples = [];
  for (const traf of kids(u8, moof)) {
    if (traf.type !== 'traf') continue;
    const tfhd = one(u8, traf, 'tfhd');
    const tfdt = one(u8, traf, 'tfdt');
    const flags = (u8[tfhd.payloadStart + 1] << 16) | (u8[tfhd.payloadStart + 2] << 8) | u8[tfhd.payloadStart + 3];
    let p = tfhd.payloadStart + 4;
    const trackId = dvAt(u8, p).getUint32(0); p += 4;
    let defDuration = 0, defSize = 0, defFlags = 0;
    if (flags & 0x01) p += 8;
    if (flags & 0x02) p += 4;
    if (flags & 0x08) { defDuration = dvAt(u8, p).getUint32(0); p += 4; }
    if (flags & 0x10) { defSize = dvAt(u8, p).getUint32(0); p += 4; }
    if (flags & 0x20) { defFlags = dvAt(u8, p).getUint32(0); p += 4; }
    let baseDts = 0;
    if (tfdt) {
      const v = u8[tfdt.payloadStart];
      baseDts = v === 1
        ? Number(dvAt(u8, tfdt.payloadStart + 4).getBigUint64(0))
        : dvAt(u8, tfdt.payloadStart + 4).getUint32(0);
    }
    for (const trun of kids(u8, traf)) {
      if (trun.type !== 'trun') continue;
      const ver = u8[trun.payloadStart];
      const tflags = (u8[trun.payloadStart + 1] << 16) | (u8[trun.payloadStart + 2] << 8) | u8[trun.payloadStart + 3];
      let q = trun.payloadStart + 4;
      const count = dvAt(u8, q).getUint32(0); q += 4;
      let dataOffset = 0, firstFlags = 0;
      if (tflags & 0x01) { dataOffset = dvAt(u8, q).getInt32(0); q += 4; }
      if (tflags & 0x04) { firstFlags = dvAt(u8, q).getUint32(0); q += 4; }
      let dts = baseDts;
      let dataPos = moof.start + dataOffset;
      for (let i = 0; i < count; i++) {
        let dur = defDuration, size = defSize, sflags = defFlags, ctsOff = 0;
        if (tflags & 0x100) { dur = dvAt(u8, q).getUint32(0); q += 4; }
        if (tflags & 0x200) { size = dvAt(u8, q).getUint32(0); q += 4; }
        if (tflags & 0x400) { sflags = dvAt(u8, q).getUint32(0); q += 4; }
        if (tflags & 0x800) {
          ctsOff = ver === 1 ? dvAt(u8, q).getInt32(0) : dvAt(u8, q).getUint32(0);
          q += 4;
        }
        if (i === 0 && (tflags & 0x04)) sflags = firstFlags;
        samples.push({
          trackId, dts, ctsOffset: ctsOff, duration: dur, size,
          sync: (sflags & 0x00010000) === 0,
          data: u8.slice(dataPos, dataPos + size)
        });
        dts += dur;
        dataPos += size;
      }
    }
  }
  return samples;
}

// ---------- output building ----------
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

function buildTrak(t, trackId, isVideo, chunkOffset) {
  const s = t.samples;
  // rebase dts to start at 0
  const d0 = s[0].dts;
  const dts = s.map((x) => x.dts - d0);
  // stts: compress durations
  const sttsEntries = [];
  for (const x of s) {
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last[1] === x.duration) last[0]++;
    else sttsEntries.push([1, x.duration]);
  }
  const hasCts = s.some((x) => x.ctsOffset !== 0);
  const cttsEntries = [];
  if (hasCts) {
    for (const x of s) {
      const last = cttsEntries[cttsEntries.length - 1];
      if (last && last[1] === x.ctsOffset) last[0]++;
      else cttsEntries.push([1, x.ctsOffset]);
    }
  }
  const mediaDuration = Math.max(...s.map((x, i) => dts[i] + x.duration));
  const tkhdDur = Math.round((mediaDuration / t.timescale) * 1000);

  let entry;
  if (isVideo) {
    entry = box(t.entryType,
      new Uint8Array(6), u16(1), u16(0), u16(0),
      u32(0), u32(0), u32(0),
      u16(t.width), u16(t.height),
      u32(0x00480000), u32(0x00480000), u32(0),
      u16(1),
      concatBytes([ascii(t.entryType + ' Compressor'), new Uint8Array(32 - (t.entryType + ' Compressor').length)]),
      u16(0x0018), u16(0xffff),
      t.configBytes);
  } else {
    entry = box(t.entryType,
      new Uint8Array(6), u16(1),
      u32(0), u32(0),
      u16(t.channels), u16(16), u16(0), u16(0),
      u32(t.sampleRate * 65536),
      t.configBytes);
  }

  const stblParts = [
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(sttsEntries.length),
      ...sttsEntries.map((e) => concatBytes([u32(e[0]), u32(e[1])]))),
  ];
  if (isVideo) {
    const syncNums = [];
    s.forEach((x, i) => { if (x.sync) syncNums.push(i + 1); });
    if (syncNums.length && syncNums.length < s.length) {
      stblParts.push(fullBox('stss', 0, 0, u32(syncNums.length), ...syncNums.map(u32)));
    }
    if (hasCts) {
      stblParts.push(fullBox('ctts', 1, 0, u32(cttsEntries.length),
        ...cttsEntries.map((e) => concatBytes([u32(e[0]), i32(e[1])]))));
    }
  }
  stblParts.push(
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(s.length), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.size))),
    fullBox('stco', 0, 0, u32(1), u32(chunkOffset))
  );

  const minfMedia = isVideo
    ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
    : fullBox('smhd', 0, 0, u16(0), u16(0));

  return box('trak',
    fullBox('tkhd', 0, 0x07, u32(0), u32(0), u32(trackId), u32(0), u32(tkhdDur),
      u32(0), u32(0), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0),
      ...MATRIX.map(u32), u32(t.width << 16), u32(t.height << 16)),
    box('mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDuration),
        u16(0x55c4), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'),
        u32(0), u32(0), u32(0), ascii(isVideo ? 'VideoHandler\0' : 'SoundHandler\0')),
      box('minf', minfMedia,
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        box('stbl', ...stblParts))));
}

function buildMoov(vTrack, aTrack, vChunkOffset, aChunkOffset) {
  const traks = [buildTrak(vTrack, 1, true, vChunkOffset)];
  if (aTrack) traks.push(buildTrak(aTrack, 2, false, aChunkOffset));
  const maxSec = Math.max(
    Math.max(...vTrack.samples.map((x, i) => (x.dts - vTrack.samples[0].dts + x.duration))) / vTrack.timescale,
    aTrack ? Math.max(...aTrack.samples.map((x, i) => (x.dts - aTrack.samples[0].dts + x.duration))) / aTrack.timescale : 0
  );
  return box('moov',
    fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(maxSec * 1000)),
      u32(0x10000), u16(0x0100), u16(0), u32(0), u32(0),
      ...MATRIX.map(u32), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(3)),
    ...traks);
}

// ---------- public pipeline ----------
async function remuxFmp4(vInit, vSegs, aInit, aSegs, onProgress) {
  const pg = onProgress || (() => {});
  const vInfo = parseInit(vInit).find((t) => t.handler === 'vide');
  if (!vInfo) throw new Error('hd-mux: no video track in init');
  let aInfo = null;
  if (aInit && aSegs && aSegs.length) {
    aInfo = parseInit(aInit).find((t) => t.handler === 'soun') || null;
  }

  const vSamples = [];
  vSegs.forEach((sg, i) => {
    for (const s of parseSegment(sg)) vSamples.push(s);
    pg('video', ((i + 1) / vSegs.length) * 0.45);
  });
  const aSamples = [];
  if (aInfo) {
    aSegs.forEach((sg, i) => {
      for (const s of parseSegment(sg)) aSamples.push(s);
      pg('audio', 0.45 + ((i + 1) / aSegs.length) * 0.4);
    });
  }
  if (!vSamples.length) throw new Error('hd-mux: zero video samples extracted');
  vSamples.sort((a, b) => a.dts - b.dts);
  aSamples.sort((a, b) => a.dts - b.dts);

  pg('mux', 0.88);
  const vTrack = { ...vInfo, samples: vSamples };
  const aTrack = aInfo ? { ...aInfo, samples: aSamples } : null;

  const ftyp = box('ftyp', ascii('isom'), u32(0), ascii('isom'), ascii('iso2'), ascii('mp41'));
  const vLen = vSamples.reduce((a, s) => a + s.size, 0);
  // Two-pass: build moov with placeholder offsets, then rebuild with real ones.
  // Chunk 1 = video samples, chunk 2 = audio samples (each track, one chunk).
  let moov = buildMoov(vTrack, aTrack, 0, 0);
  const vChunkOffset = ftyp.length + moov.length + 8; // +8 = mdat header
  const aChunkOffset = vChunkOffset + vLen;
  moov = buildMoov(vTrack, aTrack, vChunkOffset, aChunkOffset);

  const mdat = box('mdat', concatBytes([
    ...vSamples.map((s) => s.data),
    ...(aTrack ? aSamples.map((s) => s.data) : [])
  ]));

  pg('done', 1);
  return concatBytes([ftyp, moov, mdat]).buffer;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { remuxFmp4 };
