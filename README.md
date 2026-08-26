# Teleparty

Watch videos together with synced playback, live chat, and floating reactions.

## What this is

A local watch-party app for **videos you own or have the right to share** (direct `.mp4` / `.webm` URLs). Create a room, invite someone with the code, load a video link, and stay in sync.

## What this is not

This does **not** stream Netflix, Disney+, or other DRM-protected services, and it does **not** bypass black-screen / screen-capture protections. Those protections are intentional and circumventing them is illegal.

## Run locally

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
