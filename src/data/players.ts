import { Rng, clamp, pick, randInt } from './rng';

export type Position =
  | 'QB' | 'HB' | 'WR' | 'TE' | 'OL'
  | 'DL' | 'LB' | 'CB' | 'S' | 'K';

export type Tier = 'bronze' | 'silver' | 'gold' | 'elite';

export interface Ratings {
  spd: number; // speed
  str: number; // strength (trucking, block shedding)
  agi: number; // agility / elusiveness (jukes, spins)
  cth: number; // catching
  car: number; // ball security / break tackles
  thp: number; // throw power
  tha: number; // throw accuracy
  blk: number; // blocking
  tak: number; // tackling
  cov: number; // coverage
  prs: number; // pass rush
  kpw: number; // kick power
  kac: number; // kick accuracy
}

export interface PlayerCard {
  id: string;
  first: string;
  last: string;
  pos: Position;
  ovr: number;
  tier: Tier;
  number: number;
  team: string;
  ratings: Ratings;
}

export const FIRST_NAMES = [
  'Marcus', 'Devin', 'Tyrell', 'Jordan', 'Cody', 'Brandon', 'Jalen', 'Austin', 'Derrick', 'Trey',
  'Malik', 'Logan', 'Isaiah', 'Caleb', 'Darius', 'Mason', 'Andre', 'Wyatt', 'Quentin', 'Rashad',
  'Elijah', 'Colton', 'Terrence', 'Grant', 'Xavier', 'Dante', 'Brody', 'Kendrick', 'Shane', 'Lamar',
  'Tavon', 'Hunter', 'Corey', 'Desmond', 'Garrett', 'Javon', 'Reggie', 'Tucker', 'Nolan', 'Cedric',
];

export const LAST_NAMES = [
  'Holloway', 'Brooks', 'Whitaker', 'Mercer', 'Dawson', 'Kingsley', 'Fontaine', 'Rutherford', 'Pryor', 'Vance',
  'Okafor', 'Langston', 'Barrett', 'Castillo', 'Dunmore', 'Ellison', 'Fairbanks', 'Greer', 'Hargrove', 'Ivey',
  'Jessup', 'Kearney', 'Lockett', 'Mabry', 'Northcutt', 'Oakes', 'Pennington', 'Quarles', 'Redmond', 'Sterling',
  'Tolliver', 'Underwood', 'Valentine', 'Westbrook', 'Yarbrough', 'Zeller', 'Ashby', 'Blackwell', 'Crowder', 'Delgado',
];

export const TEAM_NAMES = [
  'Bay City Breakers', 'Mesa Coyotes', 'Iron Valley Forge', 'Lakeshore Gulls', 'Capital Sentinels',
  'Delta Riverhawks', 'Summit Avalanche', 'Gulf Coast Marlins', 'Prairie Thunder', 'Harbor Kraken',
  'Copper Canyon Scorpions', 'Northwoods Timber', 'Neon City Voltage', 'Redrock Rattlers', 'Atlantic Admirals',
  'Bluegrass Stallions',
];

/** Which ratings matter for each position, with weights summing to 1. */
export const OVR_WEIGHTS: Record<Position, Partial<Record<keyof Ratings, number>>> = {
  QB: { thp: 0.35, tha: 0.45, spd: 0.1, agi: 0.1 },
  HB: { spd: 0.3, agi: 0.3, car: 0.25, str: 0.1, cth: 0.05 },
  WR: { spd: 0.4, cth: 0.4, agi: 0.15, car: 0.05 },
  TE: { cth: 0.35, blk: 0.3, str: 0.15, spd: 0.2 },
  OL: { blk: 0.7, str: 0.3 },
  DL: { prs: 0.45, str: 0.3, tak: 0.2, spd: 0.05 },
  LB: { tak: 0.4, spd: 0.25, cov: 0.2, prs: 0.15 },
  CB: { cov: 0.5, spd: 0.4, tak: 0.1 },
  S: { cov: 0.4, tak: 0.3, spd: 0.3 },
  K: { kpw: 0.5, kac: 0.5 },
};

export function computeOvr(pos: Position, r: Ratings): number {
  let total = 0;
  for (const [k, w] of Object.entries(OVR_WEIGHTS[pos])) total += r[k as keyof Ratings] * (w as number);
  return Math.round(total);
}

export function tierFor(ovr: number): Tier {
  if (ovr >= 85) return 'elite';
  if (ovr >= 75) return 'gold';
  if (ovr >= 65) return 'silver';
  return 'bronze';
}

export const TIER_RANGES: Record<Tier, [number, number]> = {
  bronze: [50, 64],
  silver: [65, 74],
  gold: [75, 84],
  elite: [85, 99],
};

/** Coins you get back for quick-selling a card. */
export function quickSellValue(card: PlayerCard): number {
  const base = { bronze: 25, silver: 150, gold: 600, elite: 2500 }[card.tier];
  return base + Math.max(0, card.ovr - TIER_RANGES[card.tier][0]) * (card.tier === 'elite' ? 300 : 20);
}

let idCounter = 0;
export function newId(rng: Rng): string {
  idCounter += 1;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(rng() * 1e6).toString(36)}`;
}

const NUMBER_RANGES: Record<Position, [number, number]> = {
  QB: [1, 19], HB: [20, 49], WR: [10, 19], TE: [80, 89], OL: [60, 79],
  DL: [90, 99], LB: [50, 59], CB: [20, 39], S: [20, 49], K: [1, 9],
};

/**
 * Generate a player at (approximately) a target OVR. Key ratings are centered on the target,
 * secondary ratings are lower, then the result is nudged so the computed OVR lands on target.
 */
export function generatePlayer(rng: Rng, pos: Position, targetOvr: number, team?: string): PlayerCard {
  const weights = OVR_WEIGHTS[pos];
  const keys: (keyof Ratings)[] = ['spd', 'str', 'agi', 'cth', 'car', 'thp', 'tha', 'blk', 'tak', 'cov', 'prs', 'kpw', 'kac'];
  const r = {} as Ratings;
  for (const k of keys) {
    const key = weights[k] !== undefined;
    r[k] = key ? clamp(targetOvr + randInt(rng, -6, 6), 35, 99) : clamp(targetOvr - 25 + randInt(rng, -10, 10), 25, 80);
  }
  // Position flavour so linemen are slow and skill players are fast.
  if (pos === 'OL' || pos === 'DL') r.spd = clamp(r.spd - 15, 40, 80);
  if (pos === 'QB') r.spd = clamp(r.spd - 5, 45, 92);
  for (let i = 0; i < 20; i++) {
    const diff = targetOvr - computeOvr(pos, r);
    if (diff === 0) break;
    for (const k of Object.keys(weights) as (keyof Ratings)[]) r[k] = clamp(r[k] + Math.sign(diff), 30, 99);
  }
  const ovr = computeOvr(pos, r);
  const [nlo, nhi] = NUMBER_RANGES[pos];
  return {
    id: newId(rng),
    first: pick(rng, FIRST_NAMES),
    last: pick(rng, LAST_NAMES),
    pos,
    ovr,
    tier: tierFor(ovr),
    number: randInt(rng, nlo, nhi),
    team: team ?? pick(rng, TEAM_NAMES),
    ratings: r,
  };
}

export function generateForTier(rng: Rng, tier: Tier, pos?: Position): PlayerCard {
  const [lo, hi] = TIER_RANGES[tier];
  // Weight toward the low end of each tier so high cards feel rare.
  const ovr = Math.round(lo + (hi - lo) * Math.pow(rng(), 1.8));
  return generatePlayer(rng, pos ?? randomPosition(rng), ovr);
}

const POSITION_POOL: Position[] = [
  'QB', 'HB', 'HB', 'WR', 'WR', 'WR', 'TE', 'OL', 'OL', 'OL', 'OL',
  'DL', 'DL', 'DL', 'LB', 'LB', 'LB', 'CB', 'CB', 'S', 'S', 'K',
];

export function randomPosition(rng: Rng): Position {
  return pick(rng, POSITION_POOL);
}

export function displayName(p: PlayerCard): string {
  return `${p.first[0]}. ${p.last}`;
}
