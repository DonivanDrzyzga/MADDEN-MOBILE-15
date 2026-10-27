# Gridiron Prime

A fan-made mobile football game inspired by the 2015/2016 era of Madden Mobile: Live Events,
Seasons, collectible player cards, packs, lineups, and fast arcade-style plays you control with
a thumbstick.

All teams, players, names, and art are original. The game uses no EA, NFL, or NFLPA names, logos,
or assets.

## What's in it

- **Gameplay:** a real-time engine running 11 on 11. It has routes, blocking, pass rush, man and zone
  coverage, catch and interception contests, broken tackles, and field goals.
  - **Offense:** call a play from 8 (3 runs and 5 passes), then tap **HIKE**. Tap a receiver
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
- **Lineup and collection:** 23 starting slots, an auto-fill option, and quick-sell for
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
npm test           # engine, match and save tests
npm run build      # production build in dist/
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
| `src/game/render.ts` | Canvas field renderer (portrait and landscape) |
| `src/ui/gameScreen.ts` | In-game HUD, play-call screen, joystick and buttons, game loop |
| `src/ui/app.ts` | Menus: home, events, season, lineup, store, collection |
| `src/data/*` | Player generation, ratings and OVR, lineups, packs, events and season schedule |
| `src/state/store.ts` | Save data, economy, stamina, rewards |
