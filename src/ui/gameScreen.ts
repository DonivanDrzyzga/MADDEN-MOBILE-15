import { Rng, defaultRng } from '../data/rng';
import { PlayEngine, Input, Vec } from '../game/engine';
import { FieldRenderer, RECEIVER_ICONS, Hud } from '../game/render';
import { Match, MatchConfig, ordinal, spotLabel, PlayReport } from '../game/match';
import { OFFENSE_PLAYBOOK, DEFENSE_PLAYBOOK, OffPlay, DefPlay, cpuDefensePlay } from '../game/plays';
import { fieldGoalChance } from '../game/engine';
import { esc, el, confirmDialog } from './dom';

export interface GameResult {
  won: boolean;
  userScore: number;
  cpuScore: number;
  touchdowns: number;
  match: Match;
}

export interface GameOptions {
  userTeam: string;
  cpuTeam: string;
  /** Called once when the match ends; returns HTML describing rewards to show the player. */
  onFinish: (result: GameResult) => string;
  /** Called when the player leaves the game screen. `result` is null if they quit early. */
  onExit: (result: GameResult | null) => void;
  rng?: Rng;
}

type Phase = 'call' | 'presnap' | 'live' | 'result' | 'between' | 'final';

const STICK_RADIUS = 52;

export function startGame(root: HTMLElement, config: MatchConfig, opts: GameOptions): () => void {
  const rng = opts.rng ?? defaultRng;
  const match = new Match(config, rng);
  const wrap = el('div', 'game');
  wrap.innerHTML = `
    <canvas class="field"></canvas>
    <div class="scorebug"></div>
    <button class="quit-btn" aria-label="Quit">✕</button>
    <div class="stick"><div class="stick-knob"></div></div>
    <div class="throw-btns"></div>
    <div class="action-btns"></div>
    <div class="overlay"></div>`;
  root.appendChild(wrap);

  const canvas = wrap.querySelector<HTMLCanvasElement>('canvas')!;
  const scorebug = wrap.querySelector<HTMLElement>('.scorebug')!;
  const overlay = wrap.querySelector<HTMLElement>('.overlay')!;
  const actionBtns = wrap.querySelector<HTMLElement>('.action-btns')!;
  const throwBtns = wrap.querySelector<HTMLElement>('.throw-btns')!;
  const stick = wrap.querySelector<HTMLElement>('.stick')!;
  const knob = wrap.querySelector<HTMLElement>('.stick-knob')!;
  const renderer = new FieldRenderer(canvas);

  let engine: PlayEngine | null = null;
  let phase: Phase = 'call';
  let resultTimer = 0;
  let pendingReport: PlayReport | null = null;
  let running = true;
  let finished = false;
  const input: Input = { move: null, sprint: false };
  let stickVec: { x: number; y: number } | null = null;
  let stickPointer: number | null = null;
  let stickOrigin = { x: 0, y: 0 };
  const keys = new Set<string>();

  const hud = (): Hud => ({
    firstDownY: match.drive.los + match.drive.toGo,
    userTeam: opts.userTeam,
    cpuTeam: opts.cpuTeam,
  });

  // ------------------------------------------------------------ HUD

  function renderScorebug(): void {
    const d = match.drive;
    const userOff = d.side === 'off';
    const left = match.playsLeft;
    scorebug.innerHTML = `
      <div class="sb-team user"><span>${esc(abbr(opts.userTeam))}</span><b>${match.userScore}</b></div>
      <div class="sb-mid">
        <div class="sb-down">${ordinal(Math.min(4, d.down))} &amp; ${match.toGoLabel}</div>
        <div class="sb-spot">${userOff ? 'OFF' : 'DEF'} · ${spotLabel(d.los, userOff)}${left !== null ? ` · ${left} play${left === 1 ? '' : 's'} left` : ''}</div>
      </div>
      <div class="sb-team cpu"><b>${match.cpuScore}</b><span>${esc(abbr(opts.cpuTeam))}</span></div>`;
  }

  function renderActionButtons(): void {
    const userOff = match.drive.side === 'off';
    if (phase !== 'live' && phase !== 'presnap') {
      actionBtns.innerHTML = '';
      throwBtns.innerHTML = '';
      return;
    }
    if (phase === 'presnap') {
      actionBtns.innerHTML = `<button class="btn-snap" data-act="snap">HIKE</button>`;
      throwBtns.innerHTML = '';
      return;
    }
    actionBtns.innerHTML = userOff
      ? `<button data-act="juke">JUKE</button><button data-act="spin">SPIN</button><button data-act="truck">TRUCK</button><button data-act="sprint" class="sprint">SPRINT</button>`
      : `<button data-act="switch">SWITCH</button><button data-act="dive">DIVE</button>`;
  }

  function renderThrowButtons(): void {
    const show = !!engine && phase === 'live' && engine.userSide === 'off' && engine.canThrow();
    wrap.classList.toggle('can-throw', show);
    if (!show) {
      if (throwBtns.childElementCount) throwBtns.innerHTML = '';
      return;
    }
    if (throwBtns.childElementCount) return;
    throwBtns.innerHTML = engine!
      .eligibleReceivers()
      .sort((a, b) => RECEIVER_ICONS[a.slot].label.localeCompare(RECEIVER_ICONS[b.slot].label))
      .map((a) => {
        const icon = RECEIVER_ICONS[a.slot];
        return `<button data-throw="${a.slot}" style="background:${icon.color}"><b>${icon.label}</b><small>${esc(a.card.last)}</small></button>`;
      })
      .join('');
  }

  // ------------------------------------------------------------ play calling

  function showPlayCall(): void {
    phase = 'call';
    renderScorebug();
    renderActionButtons();
    const d = match.drive;
    if (d.side === 'def') {
      const choice = match.cpuSpecialTeams();
      if (choice === 'fg') return afterSpecial(match.kickFieldGoal());
      if (choice === 'punt') return afterSpecial(match.punt());
    }
    const userOff = d.side === 'off';
    const plays = userOff ? OFFENSE_PLAYBOOK : DEFENSE_PLAYBOOK;
    const special: string[] = [];
    if (userOff) {
      const scen = config.scenario;
      const fgAllowed = match.canKickFg() && (config.kind === 'season' ? d.down === 4 : scen?.goal === 'score');
      if (fgAllowed) {
        const pct = Math.round(fieldGoalChance(match.offenseRoster.K, match.fgDistance()) * 100);
        special.push(`<button class="special" data-special="fg">Field Goal<br><small>${match.fgDistance()} yds · ${pct}%</small></button>`);
      }
      if (config.kind === 'season' && d.down === 4) special.push(`<button class="special" data-special="punt">Punt</button>`);
    }
    overlay.innerHTML = `
      <div class="playcall">
        <div class="playcall-head">
          <div>${esc(match.possessionLabel)}</div>
          <h2>${userOff ? 'Call your play' : 'Call a defense'}</h2>
          ${config.scenario ? `<div class="objective">${esc(config.scenario.desc)}</div>` : ''}
        </div>
        <div class="play-grid">
          ${plays
            .map(
              (p) => `<button class="play-card ${'type' in p ? (p as OffPlay).type : 'def'}" data-play="${p.id}">
                <span class="play-type">${'type' in p ? ((p as OffPlay).type === 'run' ? 'RUN' : 'PASS') : 'DEF'}</span>
                ${playDiagram(p)}
                <b>${esc(p.name)}</b><small>${esc(p.desc)}</small></button>`,
            )
            .join('')}
        </div>
        ${special.length ? `<div class="special-row">${special.join('')}</div>` : ''}
      </div>`;
  }

  function selectPlay(id: string): void {
    const d = match.drive;
    const userOff = d.side === 'off';
    let offPlay: OffPlay;
    let defPlay: DefPlay;
    if (userOff) {
      offPlay = OFFENSE_PLAYBOOK.find((p) => p.id === id)!;
      defPlay = cpuDefensePlay(rng, d.down, d.toGo);
    } else {
      defPlay = DEFENSE_PLAYBOOK.find((p) => p.id === id)!;
      offPlay = match.cpuOffensePlay();
    }
    engine = new PlayEngine({
      los: d.los,
      offense: match.offenseRoster,
      defense: match.defenseRoster,
      offPlay,
      defPlay,
      userSide: d.side,
      rng,
    });
    renderer.focus(engine.ballPos().x, d.los + 4);
    overlay.innerHTML = `<div class="presnap-tag">${esc(userOff ? offPlay.name : defPlay.name)}${
      userOff ? '' : `<small>They're in ${esc(offPlay.type === 'run' ? 'a run look' : 'a pass look')}</small>`
    }</div>`;
    phase = 'presnap';
    renderActionButtons();
  }

  function snap(): void {
    if (phase !== 'presnap') return;
    overlay.innerHTML = '';
    phase = 'live';
    renderActionButtons();
  }

  function afterSpecial(report: PlayReport): void {
    pendingReport = report;
    showBanner(report.text, report.scoreChange.user > 0 ? 'good' : report.scoreChange.cpu > 0 ? 'bad' : '');
    phase = 'result';
    resultTimer = 1.8;
  }

  function showBanner(text: string, mood: string): void {
    overlay.innerHTML = `<div class="banner ${mood}">${esc(text)}</div>`;
  }

  function onPlayOver(): void {
    const o = engine!.outcome!;
    const report = match.applyPlay(o);
    pendingReport = report;
    const userOff = match.drive.side === 'off';
    const goodForOffense = o.kind === 'td' || ((o.kind === 'tackle' || o.kind === 'oob') && o.yards > 0);
    showBanner(report.text, goodForOffense === userOff ? 'good' : 'bad');
    phase = 'result';
    resultTimer = o.kind === 'td' ? 2.2 : 1.6;
    renderActionButtons();
  }

  function afterResult(): void {
    const report = pendingReport;
    pendingReport = null;
    renderScorebug();
    if (!report?.driveOver) return showPlayCall();
    if (config.kind === 'event') return finish();
    const result = match.drive.result;
    const label: Record<string, string> = {
      td: 'Touchdown', fg: 'Field goal', 'missed-fg': 'Missed field goal', turnover: 'Turnover', downs: 'Turnover on downs',
      punt: 'Punt', safety: 'Safety', 'out-of-plays': 'Drive over', 'first-down': 'First down',
    };
    const wasUserOff = match.drive.side === 'off';
    if (!match.nextPossession()) return finish();
    phase = 'between';
    const next = match.drive.side === 'off' ? 'Your offense is up' : 'Your defense is up';
    overlay.innerHTML = `
      <div class="panel">
        <div class="eyebrow">${wasUserOff ? 'Offensive' : 'Defensive'} drive complete</div>
        <h2>${esc(label[result ?? ''] ?? 'Drive over')}</h2>
        <div class="bigscore"><span>${esc(abbr(opts.userTeam))} ${match.userScore}</span><span>${match.cpuScore} ${esc(abbr(opts.cpuTeam))}</span></div>
        <p>${next} · ${esc(match.possessionLabel)}</p>
        <button class="btn primary" data-next="1">Continue</button>
      </div>`;
    renderScorebug();
  }

  function finish(): void {
    phase = 'final';
    match.over = true;
    const won = config.kind === 'event' ? match.eventWon() : match.userScore > match.cpuScore;
    const result: GameResult = { won, userScore: match.userScore, cpuScore: match.cpuScore, touchdowns: match.userTouchdowns, match };
    const rewards = finished ? '' : opts.onFinish(result);
    finished = true;
    overlay.innerHTML = `
      <div class="panel final ${won ? 'won' : 'lost'}">
        <div class="eyebrow">${config.kind === 'event' ? esc(config.scenario!.title) : 'Final'}</div>
        <h1>${won ? (config.kind === 'event' ? 'EVENT COMPLETE' : 'VICTORY') : config.kind === 'event' ? 'EVENT FAILED' : 'DEFEAT'}</h1>
        ${config.kind === 'season' ? `<div class="bigscore"><span>${esc(abbr(opts.userTeam))} ${match.userScore}</span><span>${match.cpuScore} ${esc(abbr(opts.cpuTeam))}</span></div>` : ''}
        ${match.overtimeNote ? `<p>${esc(match.overtimeNote)}</p>` : ''}
        <div class="rewards">${rewards}</div>
        <button class="btn primary" data-exit="1">Continue</button>
      </div>`;
    wrap.querySelector<HTMLElement>('[data-exit]')!.onclick = () => {
      cleanup();
      opts.onExit(result);
    };
  }

  // ------------------------------------------------------------ input

  function updateMoveFromInputs(): void {
    let v: Vec | null = null;
    if (stickVec) v = renderer.screenDirToWorld(stickVec.x, stickVec.y);
    else {
      const kx = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0);
      const ky = (keys.has('ArrowDown') || keys.has('s') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('w') ? 1 : 0);
      if (kx || ky) {
        const l = Math.hypot(kx, ky);
        v = renderer.screenDirToWorld(kx / l, ky / l);
      }
    }
    input.move = v;
  }

  function tryThrowAt(px: number, py: number): boolean {
    if (!engine || phase !== 'live' || engine.userSide !== 'off' || !engine.canThrow()) return false;
    const rect = canvas.getBoundingClientRect();
    const x = px - rect.left;
    const y = py - rect.top;
    let best = null;
    let bd = 34;
    for (const a of engine.eligibleReceivers()) {
      const ip = renderer.iconPos(a);
      const pp = renderer.toScreen(a.x, a.y);
      const d = Math.min(Math.hypot(ip.sx - x, ip.sy - y), Math.hypot(pp.sx - x, pp.sy - y));
      if (d < bd) { bd = d; best = a; }
    }
    if (best) engine.throwTo(best);
    return !!best;
  }

  function onPointerDown(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('button') || phase === 'call' || phase === 'between' || phase === 'final') return;
    if (tryThrowAt(e.clientX, e.clientY)) return;
    if (stickPointer !== null) return;
    stickPointer = e.pointerId;
    stickOrigin = { x: e.clientX, y: e.clientY };
    stickVec = null;
    stick.style.display = 'block';
    stick.style.left = `${e.clientX - STICK_RADIUS}px`;
    stick.style.top = `${e.clientY - STICK_RADIUS}px`;
    knob.style.transform = 'translate(0px, 0px)';
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== stickPointer) return;
    let dx = e.clientX - stickOrigin.x;
    let dy = e.clientY - stickOrigin.y;
    const l = Math.hypot(dx, dy);
    if (l > STICK_RADIUS) { dx = (dx / l) * STICK_RADIUS; dy = (dy / l) * STICK_RADIUS; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Small dead zone so resting a thumb on the stick doesn't drift the player.
    stickVec = Math.hypot(dx, dy) / STICK_RADIUS < 0.18 ? null : { x: dx / STICK_RADIUS, y: dy / STICK_RADIUS };
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== stickPointer) return;
    stickPointer = null;
    stickVec = null;
    stick.style.display = 'none';
  }

  function onAction(act: string, down: boolean): void {
    if (!engine) return;
    if (act === 'sprint') { input.sprint = down; return; }
    if (!down) return;
    if (act === 'snap') return snap();
    if (phase !== 'live') return;
    if (act === 'juke') engine.juke();
    else if (act === 'spin') engine.spin();
    else if (act === 'truck') engine.truck();
    else if (act === 'switch') engine.switchPlayer();
    else if (act === 'dive') engine.dive();
  }

  wrap.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    const actBtn = t.closest<HTMLElement>('[data-act]');
    if (actBtn) {
      e.preventDefault();
      onAction(actBtn.dataset.act!, true);
      return;
    }
    const throwBtn = t.closest<HTMLElement>('[data-throw]');
    if (throwBtn && engine?.canThrow()) {
      e.preventDefault();
      const target = engine.eligibleReceivers().find((a) => a.slot === throwBtn.dataset.throw);
      if (target) engine.throwTo(target);
      return;
    }
    onPointerDown(e);
  });
  wrap.addEventListener('pointerup', (e) => {
    const actBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (actBtn) onAction(actBtn.dataset.act!, false);
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  overlay.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const play = t.closest<HTMLElement>('[data-play]');
    if (play && phase === 'call') return selectPlay(play.dataset.play!);
    const sp = t.closest<HTMLElement>('[data-special]');
    if (sp && phase === 'call') return afterSpecial(sp.dataset.special === 'fg' ? match.kickFieldGoal() : match.punt());
    if (t.closest('[data-next]') && phase === 'between') return showPlayCall();
  });

  wrap.querySelector<HTMLElement>('.quit-btn')!.onclick = async () => {
    if (phase === 'final') return;
    if (!(await confirmDialog('Quit this game? You will not earn any rewards.', 'Quit'))) return;
    if (!running) return;
    cleanup();
    opts.onExit(null);
  };

  const keyMap: Record<string, string> = { j: 'juke', k: 'spin', l: 'truck', Shift: 'sprint', ' ': 'snap', q: 'switch', e: 'dive' };
  function onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (down) keys.add(k); else keys.delete(k);
    if (down && /^[1-5]$/.test(k) && engine?.canThrow()) {
      const r = engine.eligibleReceivers()[Number(k) - 1];
      if (r) engine.throwTo(r);
    }
    const act = keyMap[k];
    if (act) {
      if (act === 'snap' && down) {
        if (phase === 'presnap') snap();
        else if (match.drive.side === 'def') engine?.dive();
      } else if (act !== 'snap') onAction(act, down);
      e.preventDefault();
    }
  }
  const kd = (e: KeyboardEvent) => onKey(e, true);
  const ku = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);

  // ------------------------------------------------------------ loop

  let last = performance.now();
  function frame(now: number): void {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    updateMoveFromInputs();
    if (phase === 'live' && engine) {
      engine.step(dt, input);
      renderThrowButtons();
      if (engine.over) onPlayOver();
    } else if (phase === 'result') {
      engine?.step(dt, input);
      resultTimer -= dt;
      if (resultTimer <= 0) afterResult();
    }
    wrap.classList.toggle('sprinting', input.sprint);
    renderer.draw(engine, hud(), dt, phase === 'presnap' && match.drive.side === 'off');
    requestAnimationFrame(frame);
  }

  function cleanup(): void {
    running = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', kd);
    window.removeEventListener('keyup', ku);
    window.removeEventListener('resize', onResize);
    wrap.remove();
  }

  renderer.resize();
  renderer.focus(26.65, match.drive.los + 4);
  showPlayCall();
  requestAnimationFrame(frame);
  return cleanup;
}

function abbr(team: string): string {
  const words = team.split(' ');
  return words.length === 1 ? team.slice(0, 3).toUpperCase() : words.map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

/** Tiny SVG chalkboard of a play for the play-call cards. */
function playDiagram(p: OffPlay | DefPlay): string {
  const W = 120;
  const H = 70;
  const sx = (dx: number) => W / 2 + dx * 2.4;
  const sy = (dy: number) => H - 14 - dy * 1.6;
  let paths = '';
  if ('type' in p) {
    const start: Record<string, [number, number]> = { WR1: [-20, 0], WR2: [20, 0], WR3: [12, 0], TE: [6.5, 0], HB: [0, -6] };
    if (p.type === 'run') {
      const h = p.hole ?? 0;
      paths += `<path d="M${sx(0)} ${sy(-6)} L${sx(h * 0.4)} ${sy(-2)} L${sx(h)} ${sy(2)} L${sx(h)} ${sy(18)}" />`;
    } else {
      for (const [r, pts] of Object.entries(p.routes ?? {})) {
        const [x0, y0] = start[r];
        let d = `M${sx(x0)} ${sy(y0)}`;
        for (const [dx, dy] of pts!) d += ` L${sx(Math.max(-24, Math.min(24, x0 + dx)))} ${sy(Math.min(26, y0 + dy))}`;
        paths += `<path d="${d}" stroke="${RECEIVER_ICONS[r].color}" />`;
      }
    }
    return `<svg class="diagram" viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${sy(0)}" y2="${sy(0)}" class="los"/>${paths}${[-4.4, -2.2, 0, 2.2, 4.4]
      .map((x) => `<circle cx="${sx(x)}" cy="${sy(-1)}" r="2.2"/>`)
      .join('')}</svg>`;
  }
  for (const a of Object.values(p.assign)) {
    if (!a) continue;
    if (a.kind === 'zone') {
      const deep = a.y >= 15;
      paths += `<ellipse cx="${sx(a.x)}" cy="${sy(Math.min(26, a.y))}" rx="${deep ? 14 : 10}" ry="${deep ? 6 : 5}" class="${deep ? 'deep' : 'under'}"/>`;
    }
  }
  const rushers = Object.values(p.assign).filter((a) => a?.kind === 'rush').length;
  const man = Object.values(p.assign).filter((a) => a?.kind === 'man').length;
  return `<svg class="diagram" viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${sy(0)}" y2="${sy(0)}" class="los"/>${paths}
    <text x="4" y="${H - 3}">${rushers} rush${man ? ` · ${man} man` : ''}</text></svg>`;
}
