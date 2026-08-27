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

The app now relays screen and camera frames through the server when WebRTC cannot connect (different Wi‑Fi / mobile). After a Render deploy, both of you should:

1. Hard-refresh (Ctrl+Shift+R)
2. Re-join the room
3. Share screen again and turn cameras on

Optional: for clearer audio across networks, add Metered TURN on Render (`METERED_DOMAIN` + `METERED_TURN_API_KEY`) — see Metered Open Relay signup.

## Sample video URL for testing

`https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`
