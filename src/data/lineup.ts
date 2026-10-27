import { PlayerCard, Position, generatePlayer, TEAM_NAMES } from './players';
import { Rng, randInt } from './rng';

export type Slot =
  | 'QB' | 'HB' | 'WR1' | 'WR2' | 'WR3' | 'TE' | 'LT' | 'LG' | 'C' | 'RG' | 'RT'
  | 'LE' | 'DT1' | 'DT2' | 'RE' | 'LOLB' | 'MLB' | 'ROLB' | 'CB1' | 'CB2' | 'FS' | 'SS'
  | 'K';

export const OFFENSE_SLOTS: Slot[] = ['QB', 'HB', 'WR1', 'WR2', 'WR3', 'TE', 'LT', 'LG', 'C', 'RG', 'RT'];
export const DEFENSE_SLOTS: Slot[] = ['LE', 'DT1', 'DT2', 'RE', 'LOLB', 'MLB', 'ROLB', 'CB1', 'CB2', 'FS', 'SS'];
export const SPECIAL_SLOTS: Slot[] = ['K'];
export const ALL_SLOTS: Slot[] = [...OFFENSE_SLOTS, ...DEFENSE_SLOTS, ...SPECIAL_SLOTS];

export const SLOT_POSITION: Record<Slot, Position> = {
  QB: 'QB', HB: 'HB', WR1: 'WR', WR2: 'WR', WR3: 'WR', TE: 'TE',
  LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL',
  LE: 'DL', DT1: 'DL', DT2: 'DL', RE: 'DL',
  LOLB: 'LB', MLB: 'LB', ROLB: 'LB',
  CB1: 'CB', CB2: 'CB', FS: 'S', SS: 'S',
  K: 'K',
};

/** Lineup maps a slot to a card id from the collection. */
export type Lineup = Partial<Record<Slot, string>>;

/** A fully-resolved roster used by the game engine. */
export type Roster = Record<Slot, PlayerCard>;

export interface TeamRatings {
  ovr: number;
  off: number;
  def: number;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export function teamRatings(roster: Partial<Record<Slot, PlayerCard>>): TeamRatings {
  const off = avg(OFFENSE_SLOTS.map((s) => roster[s]?.ovr ?? 40));
  const def = avg(DEFENSE_SLOTS.map((s) => roster[s]?.ovr ?? 40));
  const k = roster.K?.ovr ?? 40;
  return {
    off: Math.round(off),
    def: Math.round(def),
    ovr: Math.round(off * 0.48 + def * 0.48 + k * 0.04),
  };
}

/** Fill every slot with the highest-OVR eligible card, never using one card twice. */
export function autoLineup(cards: PlayerCard[]): Lineup {
  const used = new Set<string>();
  const lineup: Lineup = {};
  const sorted = [...cards].sort((a, b) => b.ovr - a.ovr);
  for (const slot of ALL_SLOTS) {
    const pos = SLOT_POSITION[slot];
    const best = sorted.find((c) => c.pos === pos && !used.has(c.id));
    if (best) {
      lineup[slot] = best.id;
      used.add(best.id);
    }
  }
  return lineup;
}

export function resolveRoster(lineup: Lineup, cards: PlayerCard[], rng: Rng): Roster {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const roster = {} as Roster;
  for (const slot of ALL_SLOTS) {
    const id = lineup[slot];
    const card = id ? byId.get(id) : undefined;
    // An empty slot is filled by a weak "practice squad" player so the game is always playable.
    roster[slot] = card ?? generatePlayer(rng, SLOT_POSITION[slot], 45, 'Practice Squad');
  }
  return roster;
}

/** Build a CPU roster that averages roughly `targetOvr`. */
export function generateCpuRoster(rng: Rng, targetOvr: number, team?: string): Roster {
  const name = team ?? TEAM_NAMES[randInt(rng, 0, TEAM_NAMES.length - 1)];
  const roster = {} as Roster;
  for (const slot of ALL_SLOTS) {
    const ovr = Math.max(45, Math.min(99, targetOvr + randInt(rng, -5, 5)));
    roster[slot] = generatePlayer(rng, SLOT_POSITION[slot], ovr, name);
  }
  return roster;
}

/** The starter roster a brand-new save receives: a full team of bronze players plus a couple of silvers. */
export function starterCards(rng: Rng): PlayerCard[] {
  const cards: PlayerCard[] = [];
  for (const slot of ALL_SLOTS) {
    const ovr = randInt(rng, 52, 62);
    cards.push(generatePlayer(rng, SLOT_POSITION[slot], ovr));
  }
  cards.push(generatePlayer(rng, 'WR', 67));
  cards.push(generatePlayer(rng, 'HB', 66));
  return cards;
}
