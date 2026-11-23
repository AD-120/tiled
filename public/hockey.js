// Air hockey across the phone wall.
// The table is the whole wall; goals sit in the middle of its top and bottom edges.
// Each phone owns one paddle inside its own tile. Whoever's paddle touches the puck
// computes the hit locally (no network lag) and publishes the new trajectory
// { x, y, vx, vy, at }. Everyone extrapolates the same path (friction + wall bounces).

export const PUCK_R = 24;
export const PADDLE_R = 42;
const FRICTION = 0.22;      // 1/s
const RESTITUTION = 0.92;
const MAX_V = 2600;         // px/s
const GOAL_FRAC = 0.46;     // goal mouth width / table width

const INK = '#121212', PAPER = '#f2eee3', PINK = '#ff48b0', CYAN = '#00a9e0', YELLOW = '#ffe800';

// fold x into [a, b] like a ball bouncing between two walls; s = direction sign after bounces
function fold(x, a, b) {
  const L = b - a;
  if (L <= 0) return { v: (a + b) / 2, s: 1 };
  let y = (x - a) % (2 * L);
  if (y < 0) y += 2 * L;
  return y > L ? { v: a + 2 * L - y, s: -1 } : { v: a + y, s: 1 };
}

export function puckAt(p, now, wall) {
  const dt = Math.max(0, (now - p.t) / 1000);
  const decay = Math.exp(-FRICTION * dt);
  const f = (1 - decay) / FRICTION;
  const fx = fold(p.x + p.vx * f, PUCK_R, wall.W - PUCK_R);
  const fy = fold(p.y + p.vy * f, PUCK_R, wall.H - PUCK_R);
  return { x: fx.v, y: fy.v, vx: p.vx * decay * fx.s, vy: p.vy * decay * fy.s };
}

// When (server ms) and for whom this trajectory scores, or null if it never reaches a goal.
// y only bounces off the ends, so the first time it reaches an end is solvable exactly.
export function goalOf(p, wall) {
  if (!p || !p.vy) return null;
  const r = PUCK_R;
  const need = Math.max(0, p.vy < 0 ? p.y - r : wall.H - r - p.y);
  const f = need / Math.abs(p.vy);                 // required (1 - e^-kt)/k
  if (FRICTION * f >= 1) return null;              // stops before reaching the end
  const dt = -Math.log(1 - FRICTION * f) / FRICTION;
  const x = fold(p.x + p.vx * f, r, wall.W - r).v;
  if (Math.abs(x - wall.W / 2) >= (wall.W * GOAL_FRAC) / 2) return null; // hits the boards
  return { at: p.t + dt * 1000, side: p.vy < 0 ? 1 : 0 }; // into the top goal = bottom player scores
}

export function resetAfter(side, wall) {
  // the player who conceded gets the puck, resting in their half
  return { x: wall.W / 2, y: side === 1 ? wall.H * 0.25 : wall.H * 0.75 };
}

export class Hockey {
  // ctx(): { state, wall, tile, view: {w,h}, myTile, now() }
  constructor(canvas, { ctx, send, toLocal }) {
    this.cv = canvas; this.g = canvas.getContext('2d');
    this.ctx = ctx; this.send = send; this.toLocal = toLocal;
    this.puck = null;          // last known trajectory (server time)
    this.paddle = null;        // { x, y, vx, vy } in wall px
    this.finger = null;        // pointerId while touching
    this.samples = [];
    this.lastV = null;         // puck velocity seen last frame (to detect bounces)
    this.flashUntil = 0; this.flashText = '';
    this.prevScore = null;
    this.prevTile = null;

    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.finger = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      this.moveTo(e, true);
    });
    canvas.addEventListener('pointermove', e => { if (e.pointerId === this.finger) this.moveTo(e); });
    const up = e => { if (e.pointerId === this.finger) { this.finger = null; if (this.paddle) { this.paddle.vx = 0; this.paddle.vy = 0; } } };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    const loop = () => { requestAnimationFrame(loop); this.frame(); };
    requestAnimationFrame(loop);
  }

  setPuck(p) { this.puck = p ? { ...p } : null; this.lastV = null; }

  onState(state) {
    if (this.prevScore && (state.score[0] !== this.prevScore[0] || state.score[1] !== this.prevScore[1])) {
      this.flashText = 'GOAL!';
      this.flashUntil = performance.now() + 1300;
    }
    this.prevScore = [...state.score];
  }

  bounds() {
    const { tile, view } = this.ctx();
    const w = Math.min(tile.w, view.w), h = Math.min(tile.h, view.h);
    return { x0: tile.x + PADDLE_R, x1: tile.x + w - PADDLE_R, y0: tile.y + PADDLE_R, y1: tile.y + h - PADDLE_R };
  }

  moveTo(e, jump) {
    const { tile } = this.ctx();
    const l = this.toLocal(e);
    const b = this.bounds();
    const x = Math.max(b.x0, Math.min(b.x1, l.x + tile.x));
    const y = Math.max(b.y0, Math.min(b.y1, l.y + tile.y));
    const t = performance.now();
    if (!this.paddle || jump) { this.paddle = { x, y, vx: 0, vy: 0 }; this.samples = [{ t, x, y }]; return; }
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0].t > 60) this.samples.shift();
    const a = this.samples[0], dt = (t - a.t) / 1000;
    if (dt > 0.004) { this.paddle.vx = (x - a.x) / dt; this.paddle.vy = (y - a.y) / dt; }
    this.paddle.x = x; this.paddle.y = y;
  }

  frame() {
    const c = this.ctx();
    if (!c.state || c.state.mode !== 'hockey' || !c.wall) return;
    const { wall, tile, state, myTile } = c;
    const now = c.now();
    const cols = state.cols, rows = state.rows;
    const row = Math.floor(Math.max(0, myTile) / cols);

    // canvas = my screen
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = c.view.w, H = c.view.h;
    if (this.cv.width !== Math.round(W * dpr) || this.cv.height !== Math.round(H * dpr)) {
      this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr);
    }

    // my paddle starts in the middle of my screen, toward my own goal
    if (!this.paddle || this.prevTile !== myTile) {
      const b = this.bounds();
      const y = row === 0 ? b.y0 + (b.y1 - b.y0) * 0.3 : row === rows - 1 ? b.y0 + (b.y1 - b.y0) * 0.7 : (b.y0 + b.y1) / 2;
      this.paddle = { x: (b.x0 + b.x1) / 2, y, vx: 0, vy: 0 };
      this.prevTile = myTile;
    }

    // no puck yet: screen 1 puts one on the centre spot
    if (!this.puck) {
      if (myTile === 0) {
        const p = { x: wall.W / 2, y: wall.H / 2, vx: 0, vy: 0, t: now };
        this.puck = p;
        this.send({ t: 'puck', x: p.x, y: p.y, vx: 0, vy: 0, at: now });
      }
      this.draw(null, now);
      return;
    }

    let p = puckAt(this.puck, now, wall);

    // --- my paddle hits the puck ---
    const pd = this.paddle;
    const dx = p.x - pd.x, dy = p.y - pd.y, dist = Math.hypot(dx, dy), min = PADDLE_R + PUCK_R;
    if (dist < min && now >= this.puck.t) {
      const nx = dist ? dx / dist : 0, ny = dist ? dy / dist : -1;
      const rvx = p.vx - pd.vx, rvy = p.vy - pd.vy;
      const vn = rvx * nx + rvy * ny;
      let vx = p.vx, vy = p.vy;
      if (vn < 0) { vx -= (1 + RESTITUTION) * vn * nx; vy -= (1 + RESTITUTION) * vn * ny; }
      const sp = Math.hypot(vx, vy);
      if (sp > MAX_V) { vx *= MAX_V / sp; vy *= MAX_V / sp; }
      const x = pd.x + nx * (min + 1), y = pd.y + ny * (min + 1);
      this.puck = { x, y, vx, vy, t: now };
      this.send({ t: 'puck', x, y, vx, vy, at: now });
      p = { x, y, vx, vy };
    }

    // --- goals: computed from the trajectory, so no phone has to catch the exact frame ---
    if (!this.puck.scored) {
      const gl = goalOf(this.puck, wall);
      if (gl && now >= gl.at) {
        const reset = resetAfter(gl.side, wall);
        this.send({ t: 'goal', side: gl.side, puckT: this.puck.t, reset });
        this.puck = { x: reset.x, y: reset.y, vx: 0, vy: 0, t: now + 800, scored: true };
        p = puckAt(this.puck, now, wall);
      }
    }
    this.lastV = { vx: p.vx, vy: p.vy };

    this.draw(p, now);
  }

  draw(p, now) {
    const { wall, tile, state, view, myTile } = this.ctx();
    const g = this.g, dpr = this.cv.width / view.w;
    const cols = state.cols, row = Math.floor(Math.max(0, myTile) / cols);
    g.setTransform(dpr, 0, 0, dpr, -tile.x * dpr, -tile.y * dpr); // draw in wall coordinates

    // table
    g.fillStyle = PAPER;
    g.fillRect(tile.x, tile.y, view.w, view.h);
    g.lineWidth = 2;
    // rink border
    g.strokeStyle = INK;
    g.strokeRect(6, 6, wall.W - 12, wall.H - 12);
    // centre line + circle
    g.save();
    g.setLineDash([10, 8]); g.strokeStyle = PINK; g.lineWidth = 3;
    g.beginPath(); g.moveTo(6, wall.H / 2); g.lineTo(wall.W - 6, wall.H / 2); g.stroke();
    g.restore();
    g.strokeStyle = CYAN; g.lineWidth = 3;
    g.beginPath(); g.arc(wall.W / 2, wall.H / 2, Math.min(90, wall.W * 0.22), 0, Math.PI * 2); g.stroke();
    // goal creases + mouths
    const gw = wall.W * GOAL_FRAC;
    for (const [y, dir] of [[0, 1], [wall.H, -1]]) {
      g.strokeStyle = CYAN; g.lineWidth = 3;
      g.beginPath(); g.arc(wall.W / 2, y, gw / 2, dir > 0 ? 0 : Math.PI, dir > 0 ? Math.PI : Math.PI * 2); g.stroke();
      g.fillStyle = PINK; g.strokeStyle = INK; g.lineWidth = 2;
      g.fillRect(wall.W / 2 - gw / 2, dir > 0 ? 0 : wall.H - 12, gw, 12);
      g.strokeRect(wall.W / 2 - gw / 2, dir > 0 ? 0 : wall.H - 12, gw, 12);
    }

    // score, big and faint, in the middle of my screen; upside down for the far player
    const cx = tile.x + view.w / 2, cy = tile.y + view.h / 2;
    g.save();
    g.translate(cx, cy);
    if (row === 0 && state.rows > 1) g.rotate(Math.PI);
    g.font = `${Math.round(Math.min(view.w, view.h) * 0.22)}px Silkscreen, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(18,18,18,.10)';
    // each player sees their own score first
    const mine = row === 0 ? 0 : 1;
    g.fillText(`${state.score[mine]}:${state.score[1 - mine]}`, 0, 0);
    if (performance.now() < this.flashUntil) {
      g.font = `${Math.round(Math.min(view.w, view.h) * 0.16)}px Silkscreen, monospace`;
      g.fillStyle = CYAN; g.fillText(this.flashText, 4, -Math.min(view.w, view.h) * 0.22 + 4);
      g.fillStyle = PINK; g.fillText(this.flashText, 0, -Math.min(view.w, view.h) * 0.22);
    }
    g.restore();

    // puck
    if (p) {
      g.fillStyle = CYAN;
      g.beginPath(); g.arc(p.x + 3, p.y + 3, PUCK_R, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK;
      g.beginPath(); g.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2); g.fill();
      g.strokeStyle = PINK; g.lineWidth = 3;
      g.beginPath(); g.arc(p.x, p.y, PUCK_R * 0.55, 0, Math.PI * 2); g.stroke();
    }

    // my paddle
    const pd = this.paddle;
    if (pd) {
      g.fillStyle = INK;
      g.beginPath(); g.arc(pd.x + 4, pd.y + 4, PADDLE_R, 0, Math.PI * 2); g.fill();
      g.fillStyle = PINK; g.strokeStyle = INK; g.lineWidth = 2.5;
      g.beginPath(); g.arc(pd.x, pd.y, PADDLE_R, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = YELLOW;
      g.beginPath(); g.arc(pd.x, pd.y, PADDLE_R * 0.42, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
}
