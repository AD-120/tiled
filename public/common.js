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
