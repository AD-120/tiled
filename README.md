# Tiled

Play one video across several phones at the same time. Each phone shows its own part of the picture. Put the phones next to each other and you see one big video.

## Using it

1. Open `/control` on a computer or a phone. This opens a new **room** with a short code and a QR code.
2. On each phone, scan the QR code (or open the site and type the code). Pick a spot on the wall and tap **התחל**.
3. From the control page, choose a layout (top/bottom, side by side, 2×2, …) and press play.

From the control page you can also seek, re-sync, flash numbers on the screens, set bezel compensation, fit mode and sound, and upload your own video. Uploads can be up to 200MB and are deleted when the room closes.

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

## Tips

- iPhone: Share → "Add to Home Screen", then open it from there. You get true full screen.
- **Fill the wall** crops the video to cover every screen. **Everything visible** letterboxes it.
- Tap a screen to see its drift/RTT, change its spot or toggle its sound.
