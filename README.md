# Loop Relay – Collaborative Music Loop Builder

Turn-based, 8-step music loops built together in real-time. Users queue up, grab a turn, and commit drums/keys/bass loops that stay locked to the global tempo. Client-side audio is powered by Tone.js, and session sync is handled with Ably.

## Features
- Session queue with active turn, auto timeouts, and pass/skip controls.
- Three instruments: 8-step drum grid (kick/snare/hat/clap) plus piano rolls for keys and bass with scale locking.
- Composition window set by BPM and loop cycles (4–6 cycles, defaults to 5).
- Active composer hears their draft + mix; everyone else hears only committed loops.
- Loop replacement (max 2 per instrument) with next-cycle starts for seamless playback.
- Tone.js transport for synced playback and step LEDs; Ably presence + state messages for realtime updates.

## Setup
1. Install dependencies  
   ```bash
   npm install
   ```
2. Add environment variables to `.env.local`  
   ```
   ABLY_API_KEY=your-ably-api-key
   ```
   Create a free Ably app and grab the API key from the dashboard.
3. Run the dev server  
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. Optional: pass `?session=custom-room` to create/join another session name.

## Notes
- No audio files are used; all synthesis is client-side via Tone.js.
- The app avoids `localStorage`/`sessionStorage`; identity is ephemeral per load.
- Vercel deployment: zero-config for the app directory, with `/api/token` serverless route issuing Ably tokens. Set `ABLY_API_KEY` in your Vercel project settings.

## Scripts
- `npm run dev` – start the dev server
- `npm run lint` – lint the project
- `npm run build` – production build
