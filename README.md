# Teleparty

Watch videos together with synced playback, live screen share, cameras, chat, and reactions.

## Links

- **GitHub:** https://github.com/Bhumit9416/teleparty
- **Vercel (UI):** https://teleparty-virid.vercel.app

> Rooms, chat, cams, and screen share need a always-on Node server (WebSockets). Vercel hosts the UI; for a **fully working** public app, deploy the same repo on [Render](https://render.com/deploy?repo=https://github.com/Bhumit9416/teleparty) (free web service), then either use that URL directly or set `VITE_SOCKET_URL` on Vercel to your Render URL and redeploy.

## Local

```bash
npm install
npm run dev
```

- App: http://localhost:5173  
- Socket server: http://localhost:3001  

## How to use

1. One person creates a room and shares the 6-character code.
2. Choose **Video link** (host pastes a direct `.mp4` / `.webm` URL) **or** **Share screen** (anyone shares a window/display into the main player).
3. Play stays in sync for links; for screen share, everyone sees the live screen in the same stage.
4. Chat and reactions work either way.
5. Optionally use **Cameras** under the player so everyone can see faces and talk while watching.

## Sample video URL for testing

Big Buck Bunny (open movie):

`https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`
