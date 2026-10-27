# Gridiron Prime

A fan-made mobile football game inspired by the 2015/2016 era of Madden Mobile: Live Events,
Seasons, collectible player cards, packs, lineups, and fast arcade-style plays you control with
a thumbstick.

All teams, players, names, and art are original. The game uses no EA, NFL, or NFLPA names, logos,
or assets.

## What's in it

- **3D presentation:** a broadcast-style camera behind the quarterback, a full stadium with crowd,
  sponsor boards and goal posts, and animated players with helmets and jersey numbers. Round
  receiver icons float above each target, and the player you control has a green ring and name
  tag. On devices without WebGL the game falls back to a top-down 2D view. The native app locks
  to landscape during games, like the original.
- **Player models:** jointed bodies (knees, elbows, hips) with textured jerseys that carry the
  player's name and number, striped glossy helmets with facemasks, skin tones, gloves and
  cleats. Bodies lean into acceleration, bank into turns, counter-rotate shoulders against
  hips, and fall along the direction of the hit. Linemen set in three-point stances.
- **Physics:** every player has a body weight from position and strength. Speed builds over a
  few steps, braking and turning have limits, and a sprinting player carves an arc instead of
  snapping to a new direction. Collisions trade momentum by mass, run blocks drive defenders
  out of the lane (and sometimes pancake them), and tackles land along the combined momentum,
  so runners fall forward for extra yards or get driven back by a big hit.
  - **Spin:** a real 360° turn that keeps most of the runner's speed and curls away from
    contact. A defender who hits him mid-spin gets spun off.
  - **Juke:** plants the outside foot and trades forward speed for a burst sideways. Push the
    stick left or right to pick the side.
  - **Truck:** lowers the shoulder. Weight and speed against the tackler's weight and
    technique decide who goes down.
- **Gameplay:** a real-time engine running 11 on 11. It has routes, blocking, pass rush, man and zone
  coverage, catch and interception contests, broken tackles, and field goals.
  - **Offense:** call a play from 8 (3 runs and 5 passes), then tap **SNAP BALL**. Tap a receiver
    icon (A–E) to throw. A white ring means he's open. Drag anywhere to run, and use
    **JUKE**, **SPIN** and **TRUCK**, or hold **SPRINT**.
  - **Defense:** call one of 5 coverages, then control the highlighted defender.
    **SWITCH** jumps to the defender nearest the ball and **DIVE** lunges for the tackle. If
    you let go of the stick, the AI plays for you.
- **Live Events:** 8 short scenarios (two-minute drill, goal-line stand, red zone and others)
  that cost stamina and pay coins and XP. Harder events unlock as you level up.
- **Season:** 12 games against opponents that get tougher each week. In each game you play 3
  offensive and 3 defensive possessions. Each new season raises the difficulty.
- **Cards and packs:** Bronze, Silver, Gold and Elite tiers. Each player has 13 ratings that
  determine their OVR, and the Bronze, Silver, Gold and Pro packs have different odds.
- **Lineup and collection:** a formation view with Offense, Defense and Special tabs, 23
  starting slots, an auto-fill option, and quick-sell for
  coins. Team OVR comes from your starters.
- **Progression:** coins, XP and levels. Stamina refills over time, and leveling up refills it
  completely.

The game saves locally on the device (`localStorage`). It plays in both portrait and landscape.
The keyboard also works: WASD or the arrow keys move, Space hikes or dives, J/K/L juke, spin
and truck, Shift sprints, 1–5 throw, and Q switches.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173. To test on a phone, open the "Network" URL Vite prints
npm test           # engine, physics, match and save tests
npm run build      # production build in dist/
npm run build:single  # one-file web build (three.js from a CDN) for shareable test links
```

## Shipping to iOS / Android

The app is a web app packaged with [Capacitor](https://capacitorjs.com/).

```bash
npx cap add android      # once (needs Android Studio)
npx cap add ios          # once (needs macOS + Xcode)
npm run cap:android      # build, sync and open Android Studio
npm run cap:ios          # build, sync and open Xcode
```

You can also install it as a home-screen app (PWA): deploy `dist/` to any static host and use
"Add to Home Screen".

## Code map

| Path | What it does |
| --- | --- |
| `src/game/engine.ts` | Real-time play simulation: movement, AI, blocking, passing, tackling, kicking |
| `src/game/plays.ts` | Offensive and defensive playbooks, formations, CPU play-calling |
| `src/game/match.ts` | Downs, scoring, drives, possessions, event win conditions |
| `src/game/render3d.ts` | 3D stadium, camera, lighting, shadows and ball (three.js) |
| `src/game/playerModel.ts` | Jointed player model, jersey/helmet textures, physics-driven poses |
| `src/game/render.ts` | Shared renderer interface and the 2D fallback renderer |
| `src/ui/gameScreen.ts` | In-game HUD, play-call screen, joystick and buttons, game loop |
| `src/ui/app.ts` | Menus: home, events, season, lineup, store, collection |
| `src/data/*` | Player generation, ratings and OVR, lineups, packs, events and season schedule |
| `src/state/store.ts` | Save data, economy, stamina, rewards |
