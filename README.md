# Teleparty

Watch videos together with synced playback, live screen share, cameras, chat, and reactions.

## Links

- **GitHub:** https://github.com/Bhumit9416/teleparty
- **Live app (use this):** https://teleparty-r3qc.onrender.com/
- **Vercel (UI only):** https://teleparty-virid.vercel.app — rooms/cams/screen need the Render URL above

## Local

```bash
npm install
npm run dev
```

- App: http://localhost:5173  
- Socket server: http://localhost:3001  

## How to use

1. Both of you open the **Render** link (not Vercel alone).
2. One creates a room and shares the 6-character code.
3. Choose **Video link** (host pastes a direct `.mp4` / `.webm` URL) **or** **Share screen**.
4. For screen share: share the **tab/window you’re watching** (not the Teleparty tab), and turn on **Share tab audio** if you want sound.
5. Both tap **Turn on camera** under Together so faces appear.
6. Hard-refresh (Ctrl+Shift+R) after a deploy if something still says “Connecting…”.

## If screen/cams stay on “Connecting…”

WebRTC needs a **TURN** relay when you’re on different Wi‑Fi or mobile data. The server includes Open Relay static-auth TURN by default. For a more reliable free TURN:

1. Sign up at [Metered Open Relay](https://www.metered.ca/tools/openrelay/) and create an app.
2. On Render → Environment, set:
   - `METERED_DOMAIN` = `your-app-name.metered.live`
   - `METERED_TURN_API_KEY` = your API key  
   Or set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` from any TURN provider.
3. Redeploy, then both hard-refresh and restart share/cameras.

Same Wi‑Fi usually works even without TURN.

## Sample video URL for testing

`https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`
