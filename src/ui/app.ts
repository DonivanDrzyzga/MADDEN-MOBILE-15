import { Store, MAX_STAMINA, SEASON_GAME_STAMINA } from '../state/store';
import { LIVE_EVENTS, Scenario, xpForLevel, SEASON_LENGTH } from '../data/events';
import { PACKS } from '../data/packs';
import { Position, quickSellValue, displayName } from '../data/players';
import { ALL_SLOTS, DEFENSE_SLOTS, OFFENSE_SLOTS, SLOT_POSITION, Slot, generateCpuRoster } from '../data/lineup';
import { defaultRng } from '../data/rng';
import { cardHtml, ratingsTable } from './card';
import { confirmDialog, esc, fmt, modal, toast } from './dom';
import { startGame, GameResult } from './gameScreen';

type Screen = 'home' | 'events' | 'season' | 'lineup' | 'packs' | 'collection';

export class App {
  private screen: Screen = 'home';
  private collectionFilter: Position | 'ALL' = 'ALL';
  private inGame = false;

  constructor(private root: HTMLElement, private store: Store) {
    store.subscribe(() => {
      if (!this.inGame) this.render();
    });
    root.addEventListener('click', (e) => this.onClick(e));
    setInterval(() => {
      if (this.inGame) return;
      const before = store.data.stamina;
      store.tickStamina();
      if (store.data.stamina !== before) store.save();
      else this.renderTopbar();
    }, 1000);
    this.render();
  }

  go(screen: Screen): void {
    this.screen = screen;
    this.render();
    this.root.querySelector('.content')?.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ layout

  render(): void {
    this.root.innerHTML = `
      <div class="shell">
        <header class="topbar"></header>
        <main class="content screen-${this.screen}">${this.renderScreen()}</main>
        <nav class="tabbar">
          ${this.tab('home', 'Home', '🏟️')}
          ${this.tab('events', 'Events', '⚡')}
          ${this.tab('season', 'Season', '🏆')}
          ${this.tab('lineup', 'Lineup', '📋')}
          ${this.tab('packs', 'Store', '🎁')}
        </nav>
      </div>`;
    this.renderTopbar();
  }

  private tab(s: Screen, label: string, icon: string): string {
    const active = this.screen === s || (s === 'lineup' && this.screen === 'collection');
    return `<button class="tab${active ? ' active' : ''}" data-go="${s}"><span>${icon}</span>${label}</button>`;
  }

  private renderTopbar(): void {
    const bar = this.root.querySelector('.topbar');
    if (!bar) return;
    const d = this.store.data;
    const ms = this.store.msUntilNextStamina();
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    const r = this.store.ratings();
    bar.innerHTML = `
      <div class="tb-level"><b>${d.level}</b><div class="xpbar"><i style="width:${(d.xp / xpForLevel(d.level)) * 100}%"></i></div></div>
      <div class="tb-ovr">OVR <b>${r.ovr}</b></div>
      <div class="tb-stam" title="Stamina">⚡ <b>${d.stamina}</b>/${MAX_STAMINA}${d.stamina < MAX_STAMINA ? `<small>${mm}:${ss}</small>` : ''}</div>
      <div class="tb-coins">🪙 <b>${fmt(d.coins)}</b></div>`;
  }

  private renderScreen(): string {
    switch (this.screen) {
      case 'home': return this.homeHtml();
      case 'events': return this.eventsHtml();
      case 'season': return this.seasonHtml();
      case 'lineup': return this.lineupHtml();
      case 'packs': return this.packsHtml();
      case 'collection': return this.collectionHtml();
    }
  }

  // ------------------------------------------------------------ screens

  private homeHtml(): string {
    const d = this.store.data;
    const r = this.store.ratings();
    const roster = this.store.roster();
    const stars = [...ALL_SLOTS].map((s) => roster[s]).sort((a, b) => b.ovr - a.ovr).slice(0, 3);
    const s = d.season;
    const wins = s.results.filter((x) => x.us > x.them).length;
    const next = s.schedule[s.week];
    return `
      <section class="hero">
        <div class="hero-text">
          <div class="eyebrow">Gridiron Prime</div>
          <h1>${esc(d.teamName)}</h1>
          <div class="team-ratings"><span>OVR <b>${r.ovr}</b></span><span>OFF <b>${r.off}</b></span><span>DEF <b>${r.def}</b></span></div>
        </div>
        <div class="hero-cards">${stars.map((c) => cardHtml(c, { small: true })).join('')}</div>
      </section>
      <div class="tiles">
        <button class="tile tile-events" data-go="events"><b>Live Events</b><span>Quick scenarios. Earn coins &amp; XP.</span></button>
        <button class="tile tile-season" data-go="season"><b>Season ${s.number}</b><span>${
          next ? `Week ${next.week} vs ${esc(next.opponent)} (${next.opponentOvr} OVR)` : 'Season complete!'
        } · ${wins}-${s.results.length - wins}</span></button>
        <button class="tile tile-packs" data-go="packs"><b>Pack Store</b><span>Bronze to Pro packs. Chase an Elite.</span></button>
        <button class="tile tile-lineup" data-go="lineup"><b>Lineup</b><span>Set your starters. Raise your OVR.</span></button>
        <button class="tile tile-collection" data-go="collection"><b>Collection</b><span>${d.cards.length} players · quick sell extras</span></button>
      </div>
      <div class="stats-row">
        <div><b>${d.stats.gamesWon}</b>Wins</div>
        <div><b>${d.stats.touchdowns}</b>TDs</div>
        <div><b>${d.stats.packsOpened}</b>Packs</div>
        <div><b>${d.cards.length}</b>Players</div>
      </div>
      <div class="howto">
        <h3>How to play</h3>
        <p><b>Offense:</b> call a play, tap <b>HIKE</b>. On pass plays tap a receiver icon (A–E) to throw — a white ring means he's open. Drag anywhere on the field to run; use <b>JUKE</b>, <b>SPIN</b>, <b>TRUCK</b> and hold <b>SPRINT</b>.</p>
        <p><b>Defense:</b> call a coverage, then drag to move your highlighted defender. <b>SWITCH</b> jumps to the defender nearest the ball and <b>DIVE</b> lunges for the tackle. Let go of the stick and the AI plays for you.</p>
        <p class="muted">Keyboard: WASD/arrows, Space hike/dive, J/K/L moves, Shift sprint, 1–5 throw, Q switch.</p>
        <button class="btn ghost small" data-reset="1">Reset save</button>
      </div>`;
  }

  private eventsHtml(): string {
    const d = this.store.data;
    return `
      <h2 class="screen-title">Live Events</h2>
      <div class="event-list">
        ${LIVE_EVENTS.map((ev) => {
          const locked = d.level < ev.minLevel;
          const wins = d.eventWins[ev.id] ?? 0;
          return `<div class="event ${ev.side}${locked ? ' locked' : ''}">
            <div class="event-head"><span class="side-tag">${ev.side === 'offense' ? 'OFFENSE' : 'DEFENSE'}</span><span class="opp">${ev.opponentOvr} OVR opp.</span></div>
            <h3>${esc(ev.title)}</h3>
            <p>${esc(ev.desc)}</p>
            <div class="event-foot">
              <span>🪙 ${fmt(ev.coins)} · ${ev.xp} XP${wins ? ` · ✔ ${wins}` : ''}</span>
              ${locked ? `<span class="lock">Level ${ev.minLevel}</span>` : `<button class="btn primary small" data-event="${ev.id}">Play ⚡${ev.stamina}</button>`}
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  private seasonHtml(): string {
    const s = this.store.data.season;
    const wins = s.results.filter((x) => x.us > x.them).length;
    const done = this.store.seasonComplete();
    return `
      <h2 class="screen-title">Season ${s.number} <small>${wins}-${s.results.length - wins}</small></h2>
      <p class="muted">Play your offense and defense on the key possessions. Each game costs ⚡${SEASON_GAME_STAMINA}.</p>
      ${done ? `<div class="panel inline"><h3>Season complete: ${wins}-${SEASON_LENGTH - wins}</h3><p>${wins >= 9 ? 'Champions! ' : ''}Opponents get tougher next season.</p><button class="btn primary" data-next-season="1">Start Season ${s.number + 1}</button></div>` : ''}
      <div class="schedule">
        ${s.schedule.map((wk, i) => {
          const res = s.results[i];
          const isNext = i === s.week;
          return `<div class="week${isNext ? ' next' : ''}${res ? (res.us > res.them ? ' win' : ' loss') : ''}">
            <span class="wk">WK ${wk.week}</span>
            <span class="opp-name">${esc(wk.opponent)}<small>${wk.opponentOvr} OVR</small></span>
            ${res ? `<b>${res.us > res.them ? 'W' : 'L'} ${res.us}-${res.them}</b>` : isNext ? `<button class="btn primary small" data-season-play="1">Play</button>` : '<span class="muted">—</span>'}
          </div>`;
        }).join('')}
      </div>`;
  }

  private lineupHtml(): string {
    const roster = this.store.roster();
    const lineup = this.store.data.lineup;
    const r = this.store.ratings();
    const slotRow = (slot: Slot) => {
      const c = roster[slot];
      const filled = !!lineup[slot];
      return `<button class="slot tier-${filled ? c.tier : 'empty'}" data-slot="${slot}">
        <span class="slot-name">${slot}</span>
        <span class="slot-ovr">${filled ? c.ovr : '—'}</span>
        <span class="slot-player">${filled ? esc(displayName(c)) : 'Empty'}</span>
      </button>`;
    };
    return `
      <h2 class="screen-title">Lineup <small>OVR ${r.ovr} · OFF ${r.off} · DEF ${r.def}</small></h2>
      <div class="row-actions"><button class="btn primary small" data-autofill="1">Auto-fill best</button><button class="btn small" data-go="collection">Collection</button></div>
      <h3 class="group">Offense</h3><div class="slots">${OFFENSE_SLOTS.map(slotRow).join('')}</div>
      <h3 class="group">Defense</h3><div class="slots">${DEFENSE_SLOTS.map(slotRow).join('')}</div>
      <h3 class="group">Special Teams</h3><div class="slots">${slotRow('K')}</div>`;
  }

  private packsHtml(): string {
    const coins = this.store.data.coins;
    return `
      <h2 class="screen-title">Pack Store</h2>
      <div class="packs">
        ${PACKS.map((p) => `
          <div class="pack" style="--pack:${p.color}">
            <div class="pack-art"><span>${esc(p.name.split(' ')[0].toUpperCase())}</span></div>
            <div class="pack-info">
              <h3>${esc(p.name)}</h3>
              <p>${esc(p.blurb)}</p>
              <button class="btn primary small" data-pack="${p.id}" ${coins < p.price ? 'disabled' : ''}>🪙 ${fmt(p.price)}</button>
            </div>
          </div>`).join('')}
      </div>
      <p class="muted center">Tiers: Bronze &lt;65 · Silver 65–74 · Gold 75–84 · Elite 85+</p>`;
  }

  private collectionHtml(): string {
    const filters: (Position | 'ALL')[] = ['ALL', 'QB', 'HB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K'];
    const cards = this.store.data.cards
      .filter((c) => this.collectionFilter === 'ALL' || c.pos === this.collectionFilter)
      .sort((a, b) => b.ovr - a.ovr);
    return `
      <h2 class="screen-title">Collection <small>${this.store.data.cards.length} players</small></h2>
      <div class="filters">${filters.map((f) => `<button class="chip${f === this.collectionFilter ? ' active' : ''}" data-filter="${f}">${f}</button>`).join('')}</div>
      <div class="card-grid">${cards.map((c) => cardHtml(c, { small: true, id: true, badge: this.store.isInLineup(c.id) ? 'STARTER' : undefined })).join('')}</div>`;
  }

  // ------------------------------------------------------------ actions

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button, [data-card]');
    if (!t || this.inGame) return;
    const ds = t.dataset;
    if (ds.go) return this.go(ds.go as Screen);
    if (ds.event) return this.playEvent(LIVE_EVENTS.find((x) => x.id === ds.event)!);
    if (ds.seasonPlay) return this.playSeasonGame();
    if (ds.nextSeason) return this.store.startNextSeason();
    if (ds.pack) return this.buyPack(ds.pack);
    if (ds.autofill) {
      this.store.autoFill();
      return toast('Lineup set to your best players');
    }
    if (ds.slot) return this.pickForSlot(ds.slot as Slot);
    if (ds.filter) {
      this.collectionFilter = ds.filter as Position | 'ALL';
      return this.render();
    }
    if (ds.card) return this.showCard(ds.card);
    if (ds.reset) {
      void confirmDialog('Erase all progress and start over?', 'Erase').then((yes) => yes && this.store.reset());
    }
  }

  private buyPack(id: string): void {
    const pack = PACKS.find((p) => p.id === id)!;
    const cards = this.store.buyPack(pack);
    if (!cards) return toast('Not enough coins');
    let revealed = 0;
    const draw = () => `
      <div class="pack-open">
        <h2>${esc(pack.name)}</h2>
        <div class="reveal">${cards.map((c, i) => (i < revealed ? `<div class="flip">${cardHtml(c, { small: true })}</div>` : `<div class="card back" data-action="reveal"></div>`)).join('')}</div>
        ${revealed < cards.length
          ? `<button class="btn primary" data-action="reveal">Reveal</button><button class="btn ghost" data-action="all">Reveal all</button>`
          : `<button class="btn primary" data-action="close">Done</button>`}
      </div>`;
    modal(draw(), (target) => {
      if (target.dataset.action === 'reveal') revealed++;
      if (target.dataset.action === 'all') revealed = cards.length;
      target.closest('.modal')!.innerHTML = draw();
      if (revealed === cards.length) {
        const best = cards[cards.length - 1];
        if (best.tier === 'elite') toast(`ELITE PULL! ${best.ovr} ${best.pos} ${best.last}`);
      }
    }, 'wide');
  }

  private showCard(id: string): void {
    const card = this.store.data.cards.find((c) => c.id === id);
    if (!card) return;
    const starter = this.store.isInLineup(id);
    const slots = ALL_SLOTS.filter((s) => SLOT_POSITION[s] === card.pos);
    modal(
      `<div class="card-detail">
        ${cardHtml(card)}
        ${ratingsTable(card)}
        <div class="detail-actions">
          ${slots.map((s) => `<button class="btn small" data-action="slot" data-to="${s}">Start at ${s}</button>`).join('')}
          <button class="btn danger small" data-action="sell" ${starter ? 'disabled' : ''}>Quick sell 🪙${fmt(quickSellValue(card))}</button>
          <button class="btn ghost small" data-action="close">Close</button>
        </div>
        ${starter ? '<p class="muted">Starters can’t be sold. Replace him in your lineup first.</p>' : ''}
      </div>`,
      (target, close) => {
        if (target.dataset.action === 'sell') {
          const v = this.store.quickSell(id);
          close();
          toast(`Sold for ${fmt(v)} coins`);
        } else if (target.dataset.action === 'slot') {
          this.store.setSlot(target.dataset.to as Slot, id);
          close();
          toast(`${card.last} is now your starting ${target.dataset.to}`);
        }
      },
    );
  }

  private pickForSlot(slot: Slot): void {
    const pos = SLOT_POSITION[slot];
    const current = this.store.data.lineup[slot];
    const options = this.store.data.cards.filter((c) => c.pos === pos).sort((a, b) => b.ovr - a.ovr);
    modal(
      `<h2>Choose ${slot}</h2>
       <div class="card-grid">${options.map((c) => `<div data-action="pick" data-id="${c.id}">${cardHtml(c, { small: true, badge: c.id === current ? 'CURRENT' : this.store.isInLineup(c.id) ? 'STARTER' : undefined })}</div>`).join('') || '<p>No players at this position. Open packs to find some!</p>'}</div>
       <button class="btn ghost" data-action="close">Cancel</button>`,
      (target, close) => {
        if (target.dataset.action === 'pick') {
          this.store.setSlot(slot, target.dataset.id!);
          close();
        }
      },
      'wide',
    );
  }

  // ------------------------------------------------------------ games

  private playEvent(ev: Scenario): void {
    if (!this.store.spendStamina(ev.stamina)) return toast('Not enough stamina — it refills over time');
    const cpu = generateCpuRoster(defaultRng, ev.opponentOvr);
    this.launch(
      { kind: 'event', userRoster: this.store.roster(), cpuRoster: cpu, cpuName: cpu.QB.team, scenario: ev },
      cpu.QB.team,
      (res) => {
        this.store.data.stats.touchdowns += res.touchdowns;
        if (!res.won) {
          const lv = this.store.reward(Math.round(ev.coins * 0.1), Math.round(ev.xp * 0.25));
          return rewardHtml(Math.round(ev.coins * 0.1), Math.round(ev.xp * 0.25), lv, 'Consolation');
        }
        this.store.data.eventWins[ev.id] = (this.store.data.eventWins[ev.id] ?? 0) + 1;
        const lv = this.store.reward(ev.coins, ev.xp);
        return rewardHtml(ev.coins, ev.xp, lv);
      },
    );
  }

  private playSeasonGame(): void {
    const s = this.store.data.season;
    const wk = s.schedule[s.week];
    if (!wk) return;
    if (!this.store.spendStamina(SEASON_GAME_STAMINA)) return toast('Not enough stamina — it refills over time');
    const cpu = generateCpuRoster(defaultRng, wk.opponentOvr, wk.opponent);
    this.launch(
      { kind: 'season', userRoster: this.store.roster(), cpuRoster: cpu, cpuName: wk.opponent },
      wk.opponent,
      (res) => {
        this.store.data.stats.touchdowns += res.touchdowns;
        this.store.recordSeasonGame(res.userScore, res.cpuScore);
        const coins = res.won ? 700 + wk.week * 100 + res.touchdowns * 50 : 200 + res.touchdowns * 50;
        const xp = res.won ? 140 : 50;
        const lv = this.store.reward(coins, xp);
        return rewardHtml(coins, xp, lv);
      },
    );
  }

  private launch(config: Parameters<typeof startGame>[1], cpuTeam: string, onFinish: (r: GameResult) => string): void {
    this.inGame = true;
    this.root.innerHTML = '';
    startGame(this.root, config, {
      userTeam: this.store.data.teamName,
      cpuTeam,
      onFinish,
      onExit: () => {
        this.inGame = false;
        this.render();
      },
    });
  }
}

function rewardHtml(coins: number, xp: number, levels: number, label = 'Rewards'): string {
  return `<div class="reward-label">${label}</div>
    <div class="reward-items"><span>🪙 +${fmt(coins)}</span><span>⭐ +${xp} XP</span></div>
    ${levels ? `<div class="levelup">LEVEL UP! Stamina refilled.</div>` : ''}`;
}
