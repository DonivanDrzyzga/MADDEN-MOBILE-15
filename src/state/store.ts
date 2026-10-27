import { PlayerCard, TEAM_NAMES, quickSellValue } from '../data/players';
import { Lineup, Roster, Slot, SLOT_POSITION, autoLineup, resolveRoster, starterCards, teamRatings, TeamRatings } from '../data/lineup';
import { PackDef, openPack } from '../data/packs';
import { SeasonWeek, seasonSchedule, xpForLevel, SEASON_LENGTH } from '../data/events';
import { Rng, defaultRng } from '../data/rng';

export const SAVE_KEY = 'gridiron-prime-save-v1';
export const MAX_STAMINA = 60;
export const STAMINA_REGEN_MS = 2 * 60 * 1000;
export const SEASON_GAME_STAMINA = 6;

export interface SeasonState {
  number: number;
  week: number; // index of the next game, 0-based
  results: { week: number; us: number; them: number; opponent: string }[];
  schedule: SeasonWeek[];
}

export interface SaveData {
  version: 1;
  teamName: string;
  coins: number;
  xp: number;
  level: number;
  stamina: number;
  staminaAt: number;
  cards: PlayerCard[];
  lineup: Lineup;
  season: SeasonState;
  eventWins: Record<string, number>;
  stats: { gamesWon: number; gamesLost: number; touchdowns: number; packsOpened: number };
}

export function newSave(rng: Rng = defaultRng, now = Date.now()): SaveData {
  const cards = starterCards(rng);
  return {
    version: 1,
    teamName: 'Prime Ballers',
    coins: 5000,
    xp: 0,
    level: 1,
    stamina: MAX_STAMINA,
    staminaAt: now,
    cards,
    lineup: autoLineup(cards),
    season: { number: 1, week: 0, results: [], schedule: seasonSchedule(1, TEAM_NAMES) },
    eventWins: {},
    stats: { gamesWon: 0, gamesLost: 0, touchdowns: 0, packsOpened: 0 },
  };
}

type Listener = () => void;

export class Store {
  data: SaveData;
  private listeners = new Set<Listener>();

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null, private rng: Rng = defaultRng) {
    this.data = this.load() ?? newSave(rng);
    this.tickStamina();
  }

  private load(): SaveData | null {
    try {
      const raw = this.storage?.getItem(SAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SaveData;
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  save(): void {
    try {
      this.storage?.setItem(SAVE_KEY, JSON.stringify(this.data));
    } catch {
      // Storage full or unavailable: the game still runs, progress just won't persist.
    }
    this.listeners.forEach((l) => l());
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  reset(): void {
    this.data = newSave(this.rng);
    this.save();
  }

  // ---- Stamina ----
  tickStamina(now = Date.now()): void {
    const d = this.data;
    if (d.stamina >= MAX_STAMINA) {
      d.staminaAt = now;
      return;
    }
    const gained = Math.floor((now - d.staminaAt) / STAMINA_REGEN_MS);
    if (gained > 0) {
      d.stamina = Math.min(MAX_STAMINA, d.stamina + gained);
      d.staminaAt = d.stamina >= MAX_STAMINA ? now : d.staminaAt + gained * STAMINA_REGEN_MS;
    }
  }

  msUntilNextStamina(now = Date.now()): number {
    if (this.data.stamina >= MAX_STAMINA) return 0;
    return STAMINA_REGEN_MS - ((now - this.data.staminaAt) % STAMINA_REGEN_MS);
  }

  spendStamina(amount: number, now = Date.now()): boolean {
    this.tickStamina(now);
    if (this.data.stamina < amount) return false;
    if (this.data.stamina >= MAX_STAMINA) this.data.staminaAt = now;
    this.data.stamina -= amount;
    this.save();
    return true;
  }

  // ---- Rewards ----
  /** Adds coins and XP; returns the number of levels gained. */
  reward(coins: number, xp: number): number {
    const d = this.data;
    d.coins += coins;
    d.xp += xp;
    let levels = 0;
    while (d.xp >= xpForLevel(d.level)) {
      d.xp -= xpForLevel(d.level);
      d.level += 1;
      levels += 1;
      d.stamina = MAX_STAMINA; // level up refills stamina, like the original
      d.staminaAt = Date.now();
    }
    this.save();
    return levels;
  }

  // ---- Cards ----
  buyPack(pack: PackDef): PlayerCard[] | null {
    if (this.data.coins < pack.price) return null;
    this.data.coins -= pack.price;
    const cards = openPack(this.rng, pack);
    this.data.cards.push(...cards);
    this.data.stats.packsOpened += 1;
    this.save();
    return cards;
  }

  isInLineup(cardId: string): boolean {
    return Object.values(this.data.lineup).includes(cardId);
  }

  quickSell(cardId: string): number {
    if (this.isInLineup(cardId)) return 0;
    const idx = this.data.cards.findIndex((c) => c.id === cardId);
    if (idx < 0) return 0;
    const value = quickSellValue(this.data.cards[idx]);
    this.data.cards.splice(idx, 1);
    this.data.coins += value;
    this.save();
    return value;
  }

  setSlot(slot: Slot, cardId: string): boolean {
    const card = this.data.cards.find((c) => c.id === cardId);
    if (!card || card.pos !== SLOT_POSITION[slot]) return false;
    // If the card is already in another slot, swap the two.
    const lineup = this.data.lineup;
    const prevSlot = (Object.keys(lineup) as Slot[]).find((s) => lineup[s] === cardId);
    if (prevSlot) lineup[prevSlot] = lineup[slot];
    lineup[slot] = cardId;
    this.save();
    return true;
  }

  autoFill(): void {
    this.data.lineup = autoLineup(this.data.cards);
    this.save();
  }

  roster(): Roster {
    return resolveRoster(this.data.lineup, this.data.cards, this.rng);
  }

  ratings(): TeamRatings {
    return teamRatings(this.roster());
  }

  // ---- Season ----
  recordSeasonGame(us: number, them: number): void {
    const s = this.data.season;
    const wk = s.schedule[s.week];
    s.results.push({ week: wk.week, us, them, opponent: wk.opponent });
    s.week += 1;
    if (us > them) this.data.stats.gamesWon += 1;
    else this.data.stats.gamesLost += 1;
    this.save();
  }

  seasonComplete(): boolean {
    return this.data.season.week >= SEASON_LENGTH;
  }

  startNextSeason(): void {
    const n = this.data.season.number + 1;
    this.data.season = { number: n, week: 0, results: [], schedule: seasonSchedule(n, TEAM_NAMES) };
    this.save();
  }
}
