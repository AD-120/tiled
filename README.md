# Tiled

Play one video across several phones at the same time. Each phone shows its own part of the picture. Put the phones next to each other and you see one big video.

## Using it

1. On the first phone, open the site and tap **Start a wall**. It opens a room and shows a QR code and a short code.
2. Every other phone scans that QR code (or opens the site → types the code → **Join**).
3. In the lobby each phone taps its spot on the wall. Any phone can choose the layout, **Portrait / Landscape**, the video and the sound.
4. Tap **Enter screen**, line the phones up, press **Play**. Tap any screen for controls.

**Landscape:** if a phone has rotation lock on, the picture rotates 90° by itself so it is still upright when the phone lies sideways. If it comes out upside down, use **Rotate 180°** in that phone's controls.

Optional: open `/control` on a computer for a bigger remote with a live preview of the wall.

## Dancers mode

Switch **Show → Dancers** (lobby, in-play menu or remote). The GIFs from the `GIFs/` folder are spread across all the screens on one continuous floor.
Grab a dancer and drag it. **Drag it phone to phone:** pull it off the edge that touches the next phone; it waits there (flashing) and the next phone's touch near it picks it up under your finger, so you keep dragging. Flick it to throw it: it glides (with friction, bouncing off the edges) onto the neighbouring phone.
Every phone computes the same path from the throw, so it crosses between screens smoothly. **Scatter dancers** shuffles them.
To add dancers, drop more `.gif` files into `GIFs/`.

## Air hockey

**Show → Hockey** switches the room to air hockey: phones upright, stacked end to end (2 phones = top/bottom), one player at each end.
Each phone has its own paddle; the puck slides from phone to phone. Goals are in the middle of the top and bottom ends.
The phone whose paddle hits the puck computes the hit locally (no lag) and publishes the new trajectory; every phone
extrapolates the same path, and goals are solved from the trajectory so none is missed or double-counted.
Use the ☰ button in the corner for the menu (taps move your paddle). **Reset score** in the menu.

## Using this server from another app

Other sites can use this server as their sync backend (CORS is open on `/api` and `/qr.svg`):
`POST /api/room`, WebSocket `/ws` with `hello` / `setTile` / `viewport` / `cmd`, plus a generic
`{t:'sync', data}` relay (merged into the room and sent to everyone else; late joiners get it in `state.sync`)
and `/qr.svg?text=<url>` for any join link. See `docs/ff-wall-prompt.md` for a worked example.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:8080/control`. The QR code automatically points to your computer's LAN address, so phones on the same Wi-Fi can join.

## Deploy (Render)

The repo includes `render.yaml`. On [Render](https://render.com), choose **New → Blueprint** and select this repo. It deploys automatically on every push.
Vercel won't work, because the server keeps WebSocket connections open for sync.

Optional environment variables: `PORT`, `MAX_UPLOAD_MB` (default 200), `UPLOAD_DIR`.

## Videos

- Built-in videos live in `public/videos/` and show up in every room.
- Use H.264 MP4: it plays on all phones.

## How sync works

- Each device measures its clock offset to the server with ping/pong and keeps the lowest-latency samples.
- The server only stores "media time `pos` at server time `at`, playing or paused". Every play or seek is scheduled about 0.7 s ahead, so all phones start together.
- Each phone checks itself every 150 ms. A large drift (>350 ms) triggers a seek, and the phone learns its own seek delay. A small drift is fixed by nudging `playbackRate` between 0.85 and 1.15.

## Design

1-bit dither × risograph: paper, thin black lines, fluorescent pink / yellow / cyan, and greys only as dither patterns. The video itself always plays in full colour.

## Tips

- iPhone: Share → "Add to Home Screen", then open it from there. You get true full screen.
- **Fill the wall** crops the video to cover every screen. **Everything visible** letterboxes it.
- Tap a screen to see its drift/RTT, change its spot or toggle its sound.
