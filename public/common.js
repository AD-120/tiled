// Shared client code: websocket link, clock sync, synced <video>, wall layout.

export class Link {
  constructor(hello) {
    this.hello = hello;          // () => hello message
    this.handlers = {};
    this.samples = [];           // clock samples {rtt, offset}
    this.offset = null;          // serverTime - performance.now()
    this.connect();
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); }
  emit(type, m) { (this.handlers[type] || []).forEach(fn => fn(m)); }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  serverNow() { return this.offset == null ? Date.now() : performance.now() + this.offset; }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      this.send(this.hello());
      // burst of pings for a quick estimate, then periodic refresh
      let n = 0;
      clearInterval(this.burst);
      this.burst = setInterval(() => { this.ping(); if (++n >= 10) clearInterval(this.burst); }, 120);
      clearInterval(this.slow);
      this.slow = setInterval(() => this.ping(), 3000);
      this.emit('open');
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'pong') return this.onPong(m);
      if (m.t === 'state' && this.offset == null) this.offset = m.serverNow - performance.now();
      this.emit(m.t, m);
    };
    ws.onclose = () => {
      clearInterval(this.burst); clearInterval(this.slow);
      if (this.stopped) return;
      this.emit('close');
      setTimeout(() => this.connect(), 1000);
    };
  }

  stop() { this.stopped = true; clearInterval(this.burst); clearInterval(this.slow); this.ws?.close(); }

  ping() { this.send({ t: 'ping', c: performance.now() }); }

  onPong({ c, s }) {
    const t = performance.now();
    const rtt = t - c;
    this.samples.push({ rtt, offset: s - (c + rtt / 2) });
    if (this.samples.length > 20) this.samples.shift();
    // use the lowest-latency samples: they carry the least error
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    this.offset = best.reduce((a, b) => a + b.offset, 0) / best.length;
    this.rtt = best[0].rtt;
  }
}

// Media time every device should be showing at server time `t`.
export function expectedPos(state, t, duration) {
  let p = state.playing ? state.pos + (t - state.at) / 1000 : state.pos;
  const d = duration || state.duration;
  if (d) {
    if (state.loop) p = ((p % d) + d) % d;
    else p = Math.min(p, d - 0.05);
  }
  return Math.max(0, p);
}

// Keeps a <video> locked to the shared clock: hard seek for big drift,
// gentle playbackRate nudges for small drift.
export class SyncedVideo {
  constructor(video, link) {
    this.v = video; this.link = link;
    this.state = null; this.seeking = false; this.seekLead = 0.08;
    this.drift = 0;
    video.addEventListener('seeked', () => {
      this.seeking = false;
      // learn how long seeks take on this device so the next one lands closer
      if (this.seekTarget != null && this.state?.playing) {
        const late = expectedPos(this.state, this.link.serverNow(), video.duration) - video.currentTime;
        this.seekLead = Math.max(0, Math.min(1, this.seekLead + late * 0.6));
      }
      this.seekTarget = null;
    });
    setInterval(() => this.tick(), 150);
  }

  setState(state) {
    const changed = !this.state || state.at !== this.state.at || state.playing !== this.state.playing;
    this.state = state;
    if (changed) this.tick(true);
  }

  tick(force) {
    const s = this.state, v = this.v;
    if (!s || !(v.readyState >= 1)) return;
    const t = this.link.serverNow();
    const want = expectedPos(s, t, v.duration);

    if (!s.playing || t < s.at) {
      // paused, or waiting for a scheduled start
      if (!v.paused) v.pause();
      v.playbackRate = 1;
      if (Math.abs(v.currentTime - s.pos) > 0.04 && !this.seeking) this.seek(s.pos);
      this.drift = 0;
      return;
    }

    if (!s.loop && v.duration && want >= v.duration - 0.06) { if (!v.paused) v.pause(); return; }

    if (v.paused) { v.play().catch(() => {}); }
    if (this.seeking) return;

    let drift = v.currentTime - want;
    // across the loop seam, compare the short way round
    if (s.loop && v.duration) {
      if (drift > v.duration / 2) drift -= v.duration;
      if (drift < -v.duration / 2) drift += v.duration;
    }
    this.drift = drift;

    if (Math.abs(drift) > 0.35 || force && Math.abs(drift) > 0.1) {
      this.seek(want + this.seekLead);
    } else if (Math.abs(drift) > 0.025) {
      v.playbackRate = Math.max(0.85, Math.min(1.15, 1 - drift * 1.5));
    } else {
      v.playbackRate = 1;
    }
  }

  seek(to) {
    this.seeking = true;
    this.seekTarget = to;
    const d = this.v.duration;
    if (d && this.state?.loop) to = to % d;
    this.v.currentTime = Math.max(0, d ? Math.min(to, d - 0.05) : to);
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => (this.seeking = false), 2000);
  }
}

// Builds the virtual "video wall": column widths / row heights from the
// screens' real viewports (CSS px ≈ same physical size on most phones).
export function wallLayout(state, screens, fallback = { w: 390, h: 844 }) {
  const { rows, cols, gap } = state;
  const colW = Array(cols).fill(0), rowH = Array(rows).fill(0);
  for (const s of screens) {
    if (s.tile < 0 || s.tile >= rows * cols || !s.w) continue;
    const r = Math.floor(s.tile / cols), c = s.tile % cols;
    colW[c] = Math.max(colW[c], s.w);
    rowH[r] = Math.max(rowH[r], s.h);
  }
  for (let c = 0; c < cols; c++) if (!colW[c]) colW[c] = fallback.w;
  for (let r = 0; r < rows; r++) if (!rowH[r]) rowH[r] = fallback.h;
  const W = colW.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  const H = rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1);
  const tileRect = i => {
    const r = Math.floor(i / cols), c = i % cols;
    let x = 0, y = 0;
    for (let k = 0; k < c; k++) x += colW[k] + gap;
    for (let k = 0; k < r; k++) y += rowH[k] + gap;
    return { x, y, w: colW[c], h: rowH[r] };
  };
  return { W, H, tileRect };
}

// Where the video sits inside the wall.
export function videoRect(wall, vw, vh, fit) {
  if (!vw || !vh) return { x: 0, y: 0, w: wall.W, h: wall.H };
  const k = fit === 'contain' ? Math.min(wall.W / vw, wall.H / vh) : Math.max(wall.W / vw, wall.H / vh);
  const w = vw * k, h = vh * k;
  return { x: (wall.W - w) / 2, y: (wall.H - h) / 2, w, h };
}

export const fmt = s => {
  s = Math.max(0, s || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Shared UI pieces (phone lobby + desktop controller)
// ---------------------------------------------------------------------------

export const PRESETS = [
  { r: 2, c: 1, name: 'Stacked' },
  { r: 1, c: 2, name: 'Side by side' },
  { r: 3, c: 1, name: '3 stacked' },
  { r: 1, c: 3, name: '3 in a row' },
  { r: 2, c: 2, name: '2 × 2' },
  { r: 2, c: 3, name: '2 × 3' },
];

export const defaultTile = orient => orient === 'landscape' ? { w: 844, h: 390 } : { w: 390, h: 844 };

export const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Upload a video file into a room. Resolves with the server's JSON.
export function uploadVideo(room, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `api/upload?room=${room}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.status)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

// Settings controls. Every element is optional: pages include the ones they need.
// ids: presets, rows, cols, orient, fit, audio, loop, gap, gapOut, video, file, uploadBtn, bar, upOut
export function bindSettings({ cmd, room, getState }) {
  const $ = id => document.getElementById(id);
  const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
  on('rows', 'change', () => cmd('layout', { rows: +$('rows').value, cols: getState().cols }));
  on('cols', 'change', () => cmd('layout', { rows: getState().rows, cols: +$('cols').value }));
  on('gap', 'input', () => { $('gapOut').textContent = $('gap').value + 'px'; });
  on('gap', 'change', () => cmd('settings', { gap: +$('gap').value }));
  on('video', 'change', () => cmd('video', { video: $('video').value }));
  on('uploadBtn', 'click', () => $('file').click());
  on('file', 'change', async () => {
    const f = $('file').files[0];
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) { $('upOut').textContent = 'Max 200MB'; return; }
    $('bar').style.display = 'block'; $('uploadBtn').disabled = true;
    try {
      await uploadVideo(room, f, p => {
        $('bar').firstElementChild.style.width = Math.round(p * 100) + '%';
        $('upOut').textContent = Math.round(p * 100) + '%';
      });
      $('upOut').textContent = 'Uploaded ✓';
    } catch { $('upOut').textContent = 'Upload failed'; }
    $('uploadBtn').disabled = false; $('bar').style.display = 'none'; $('file').value = '';
  });
}

export function renderSettings({ state, videos, cmd }) {
  const $ = id => document.getElementById(id);
  const seg = (id, value, pick) => {
    const el = $(id); if (!el) return;
    for (const b of el.children) { b.classList.toggle('on', b.dataset.v === String(value)); b.onclick = () => pick(b.dataset.v); }
  };
  seg('orient', state.orient, v => cmd('settings', { orient: v }));
  seg('fit', state.fit, v => cmd('settings', { fit: v }));
  seg('audio', state.audio, v => cmd('settings', { audio: v }));
  seg('loop', state.loop ? 1 : 0, v => cmd('settings', { loop: v === '1' }));
  if ($('rows')) { $('rows').value = state.rows; $('cols').value = state.cols; }
  if ($('gap') && document.activeElement !== $('gap')) { $('gap').value = state.gap; $('gapOut').textContent = state.gap + 'px'; }
  if ($('video')) {
    $('video').innerHTML = videos.map(f => `<option value="${esc(f.src)}" ${f.src === state.video ? 'selected' : ''}>${esc(f.name)}</option>`).join('')
      || '<option>No videos yet: upload one</option>';
  }
  const p = $('presets');
  if (p) {
    p.innerHTML = '';
    for (const pr of PRESETS) {
      const b = document.createElement('button');
      b.className = 'btn preset' + (state.orient === 'landscape' ? ' land' : '') + (state.rows === pr.r && state.cols === pr.c ? ' on' : '');
      const cell = state.orient === 'landscape' ? 22 : 11;
      b.innerHTML = `<span class="mini" style="grid-template-columns:repeat(${pr.c},${cell}px)">${'<i></i>'.repeat(pr.r * pr.c)}</span>${pr.name}`;
      b.onclick = () => cmd('layout', { rows: pr.r, cols: pr.c });
      p.appendChild(b);
    }
  }
}

// ---------------------------------------------------------------------------
// Wall preview: the live video (full colour) with the tiles drawn on top.
// ---------------------------------------------------------------------------
const PAPER = 'rgb(242, 238, 227)';

export class WallView {
  constructor(el, { video, onPick, maxHeight }) {
    this.el = el; this.video = video; this.onPick = onPick;
    this.maxHeight = maxHeight; // () => px. When set, the box height follows the wall's shape.
    el.classList.add('wall');
    this.frame = document.createElement('div'); this.frame.className = 'wall-frame';
    this.canvas = document.createElement('canvas');
    this.tiles = document.createElement('div');
    this.frame.append(this.canvas, this.tiles);
    el.append(this.frame);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.last = 0;
    new ResizeObserver(() => this.layout()).observe(el);
    const loop = t => { if (t - this.last > 40 && this.el.offsetParent) { this.last = t; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  update(state, screens, { myTile = -1, myId = null, fallback } = {}) {
    Object.assign(this, { state, screens, myTile, myId, fallback });
    this.layout();
  }

  layout() {
    const { state, screens } = this;
    if (!state) return;
    const wall = this.wall = wallLayout(state, screens, this.fallback || defaultTile(state.orient));
    if (this.maxHeight) {
      const w = this.el.clientWidth;
      if (w) this.el.style.height = Math.round(Math.min(this.maxHeight(), (w * wall.H) / wall.W)) + 'px';
    }
    const box = this.el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const k = this.k = Math.min(box.width / wall.W, box.height / wall.H);
    this.frame.style.width = wall.W * k + 'px';
    this.frame.style.height = wall.H * k + 'px';
    this.scale = k * Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(wall.W * this.scale));
    this.canvas.height = Math.max(1, Math.round(wall.H * this.scale));

    this.tiles.innerHTML = '';
    const n = state.rows * state.cols;
    for (let i = 0; i < n; i++) {
      const t = wall.tileRect(i);
      const holder = screens.find(s => s.tile === i);
      const mine = i === this.myTile;
      const b = document.createElement(this.onPick ? 'button' : 'div');
      b.className = 'wall-tile ' + (mine ? 'mine' : holder ? 'taken' : 'free');
      Object.assign(b.style, { left: t.x * k + 'px', top: t.y * k + 'px', width: t.w * k + 'px', height: t.h * k + 'px' });
      const status = mine ? 'you' : holder ? 'taken' : 'free';
      b.innerHTML = `<span class="tag">${i + 1}<small>${status}</small></span>`;
      if (this.onPick) { b.type = 'button'; b.onclick = () => this.onPick(i); b.setAttribute('aria-label', `Screen ${i + 1}, ${status}`); }
      this.tiles.appendChild(b);
    }
    if (state.gap > 0) {
      for (let c = 1; c < state.cols; c++) {
        const t = wall.tileRect(c), g = document.createElement('div'); g.className = 'wall-gap';
        Object.assign(g.style, { left: (t.x - state.gap) * k + 'px', top: 0, width: state.gap * k + 'px', height: '100%' });
        this.tiles.appendChild(g);
      }
      for (let r = 1; r < state.rows; r++) {
        const t = wall.tileRect(r * state.cols), g = document.createElement('div'); g.className = 'wall-gap';
        Object.assign(g.style, { top: (t.y - state.gap) * k + 'px', left: 0, height: state.gap * k + 'px', width: '100%' });
        this.tiles.appendChild(g);
      }
    }
    this.draw();
  }

  draw() {
    const { ctx, canvas, video: v, wall, state } = this;
    if (!wall) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!(v.readyState >= 2 && v.videoWidth)) return;
    const r = videoRect(wall, v.videoWidth, v.videoHeight, state.fit);
    const s = this.scale;
    ctx.drawImage(v, r.x * s, r.y * s, r.w * s, r.h * s);
  }
}
