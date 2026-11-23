# Prompt: show the F&F 3D view across several phones ("tile mode")

Paste everything below the line into a Claude Code session opened in the F&F repo
(`F&F_sandbox`, GitHub `AD-120/ff-family-app`).

---

Add a **tile mode** to the F&F mockup: the 3D photo view can be shown across 2+ phones laid next to each other, as one continuous picture. Turning, tilting or zooming on any phone moves the scene on all of them.

## Which view

The target is the 3D scene that shows photos in space in the mockup (`app/index.html`, the `.s3` CSS-3D scenes: Space / Circles / Rashomon). Read `CLAUDE.md` first. If it turns out I meant the Family Galaxy (`app/galaxy/`, three.js), ask me before starting. Change only the project you're working on.

## Backend: a small dedicated server, inside this repo

F&F gets its **own** sync server. Do not use or depend on my Tiled server. (Vercel can't hold WebSockets, so this has to be a separate service.)

- Put it in `tile-server/` at the repo root: `package.json` (Node ≥ 18, deps `ws` and `qrcode` only), `server.js`, `README.md`. Add a root `render.yaml` that deploys it as its own Render web service: `name: ff-tile`, `rootDir: tile-server`, `plan: free`, `buildCommand: npm ci`, `startCommand: node server.js`, `healthCheckPath: /healthz`. Vercel keeps serving only `app/`, so make sure nothing in `tile-server/` ends up in the site.
- Update `CLAUDE.md`: a third part, "Tile server", in its own folder. It belongs to the mockup's tile mode.
- Reference only: my Tiled app (`github.com/AD-120/tiled`, `server.js` and `public/common.js`) already solves rooms, tiles and the clock. Read it with `gh` and borrow the ideas, but write a lean server for this app. Keep it about 150 lines: no video, uploads, dancers or hockey.
- In the client, put the server address in a constant `TILE_SERVER` (the Render URL once it's deployed), overridable with `?tileServer=http://localhost:8787` for local testing.
- Free Render instances sleep after ~15 min idle, and the first request then takes ~30 s. Show a "Waking the tile server…" state, don't fail fast.
- Rooms live in memory. Drop a room 1 h after its last client leaves. Handle `noroom` in the client by going back to the start screen.

The server's protocol (all JSON):

| Step | Call | Reply |
|---|---|---|
| Open a room | `POST /api/room` (CORS open to `*` on `/api` and `/qr.svg`) | `{ code: "AB12" }` (4 chars, no 0/O/1/I) |
| Connect | WebSocket `/ws`, send `{t:'hello', room, w, h, tile?}`, where `w,h` = this phone's viewport in CSS px | `{t:'welcome', id}` then `{t:'state', state, screens, sync, serverNow}`, or `{t:'noroom'}` |
| Layout | `state = {rows, cols, gap}` (default 2×1, gap 0), `screens: [{id, tile, w, h}]`. Give each new phone the first free tile; repack when the layout shrinks | `state` re-broadcast to the room on every change |
| Pick my spot | `{t:'setTile', tile}` (swaps with whoever had it) | `state` |
| Viewport changed | `{t:'viewport', w, h}` | `state` |
| Change layout | `{t:'layout', rows, cols}` (1–6 each), `{t:'gap', gap}` (0–200) | `state` |
| Flash numbers | `{t:'identify'}` | everyone gets `{t:'identify'}` |
| Clock | `{t:'ping', c}` | `{t:'pong', c, s: Date.now()}`. Client offset = `s - (c + rtt/2)`, keep the lowest-RTT samples |
| **Share scene state** | `{t:'sync', data:{…}}`: shallow-merged into the room's `sync` | everyone **else** gets `{t:'sync', data, from}`; late joiners get the merged object in `state.sync` |
| Join QR | `GET /qr.svg?text=<url>` (http/https only, ≤ 500 chars) | SVG |
| Health | `GET /healthz` | `ok` |

Also: WebSocket `maxPayload` 64 KB, ping/terminate dead sockets every 25 s (Render's proxy drops idle ones), cap rooms at ~500.

Only camera/scene state goes through the server (angles, zoom, which screen, which item is selected). **Never send photos or names.**

## Geometry: all phones together as one surface, the "wall" (same math as Tiled)

```js
// screens: [{tile, w, h}], state: {rows, cols, gap}
function wallLayout(state, screens, fallback) {
  const { rows, cols, gap } = state;
  const colW = Array(cols).fill(0), rowH = Array(rows).fill(0);
  for (const s of screens) {
    if (s.tile < 0 || s.tile >= rows * cols || !s.w) continue;
    const r = Math.floor(s.tile / cols), c = s.tile % cols;
    colW[c] = Math.max(colW[c], s.w); rowH[r] = Math.max(rowH[r], s.h);
  }
  colW.forEach((v, i) => { if (!v) colW[i] = fallback.w; });
  rowH.forEach((v, i) => { if (!v) rowH[i] = fallback.h; });
  const W = colW.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  const H = rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1);
  const tileRect = i => {
    const r = Math.floor(i / cols), c = i % cols; let x = 0, y = 0;
    for (let k = 0; k < c; k++) x += colW[k] + gap;
    for (let k = 0; k < r; k++) y += rowH[k] + gap;
    return { x, y, w: colW[c], h: rowH[r] };
  };
  return { W, H, tileRect };
}
```

## Rendering one slice of one big scene

Every phone renders **the whole scene as if its screen were the whole wall** (W×H), then shows only its own tile. The perspective must belong to the wall, not to each phone, or the lines won't continue across phones.

- **CSS 3D (`.s3`)**: in tile mode, size the scene's perspective container to `W×H` px with `perspective-origin: W/2 H/2`, put it in a full-screen `overflow:hidden` box, and shift it by `translate(-tile.x px, -tile.y px)`. Scale the scene content to the wall the same way it fits its normal box today (keep proportions, e.g. scale by `min(W/normalW, H/normalH)`).
- **three.js** (if it's the galaxy): renderer at the phone's size, `camera.aspect = W/H`, `camera.setViewOffset(W, H, tile.x, tile.y, viewW, viewH)`, `updateProjectionMatrix()`.

Hide the app chrome (nav, headers, sheets) on the tiled screens. Only the scene shows, black/paper behind it, plus a small corner button to exit.

## Interaction

- Drag/pinch/wheel on **any** phone changes the shared camera. Convert gestures exactly as the view does today, so the feel doesn't change.
- Send `{t:'sync', data:{cam:{…}, view:'rashomon', sel:…}}` while interacting (throttle ~30/s, plus once on release). Apply incoming state by easing toward it, so it doesn't jump. While this phone is being dragged, ignore incoming `cam` for ~300 ms (last writer wins, no fighting).
- Any automatic motion (idle spin, glide between screens) must run on the **shared clock** (`serverNow` from ping/pong), not each phone's own time, or the phones drift apart.

## Flow / UI (match the mockup's existing visual language and tokens)

1. A **"Tile"** button on the 3D view → sheet: **Start tiling** or **Join** with a code.
2. Start: create the room → show the QR (join URL = this page + `?tile=CODE`), the code, layout presets (**Stacked 2×1**, **Side by side 1×2**, 2×2), the phone count, and **"Use this phone as screen 1 ▸"**.
3. Opening `?tile=CODE` joins directly: tile picker (tap your spot on a small diagram of the wall) → **Enter**.
4. Enter = fullscreen when available, keep the screen awake (Wake Lock), flash the screen number for 2 s.
5. Exit returns to the normal app. The room keeps working for the other phones.

Portrait phones only for v1.

## Constraints

- Stay inside `app/index.html` (single file, inline JS/CSS, no build step, no new dependencies). If you do add a file, follow `CLAUDE.md` about `sw.js` (bump `V`) and make sure the service worker never intercepts the WebSocket or `TILE_SERVER` requests.
- Don't touch `archive/` or the other project.
- Don't break the normal (single-phone) experience. Tile mode is opt-in.

## Done when

- Local: `cd tile-server && npm install && PORT=8787 node server.js`, plus `python3 -m http.server 8765 --directory app`, and open the app with `?tileServer=http://localhost:8787`. Two browser tabs at 375×812 in one room, stacked: the scene continues across the seam with no jump in perspective.
- A drag in one tab updates the other within ~100 ms. A third tab that joins late shows the current camera at once.
- `?tile=` links work from the QR on a real phone, and on a Vercel preview URL (push to a branch, not `main`).
- Deploying the server is my step: I connect this repo (`AD-120/ff-family-app`) in Render as a new Blueprint, separate from Tiled. Tell me exactly what to click (New → Blueprint → this repo → Apply). Then put the Render URL into `TILE_SERVER`.
- Report what you tested and what you couldn't (for example, real phones).
