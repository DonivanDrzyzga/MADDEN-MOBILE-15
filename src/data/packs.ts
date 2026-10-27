import { PlayerCard, Tier, generateForTier } from './players';
import { Rng } from './rng';

export interface PackDef {
  id: string;
  name: string;
  price: number;
  size: number;
  /** Odds for each card slot, highest tier checked first. The last slot uses `bonusOdds`. */
  odds: Partial<Record<Tier, number>>;
  bonusOdds: Partial<Record<Tier, number>>;
  color: string;
  blurb: string;
}

export const PACKS: PackDef[] = [
  {
    id: 'bronze', name: 'Bronze Pack', price: 1000, size: 5,
    odds: { silver: 0.05 }, bonusOdds: { gold: 0.02, silver: 0.4 },
    color: '#b07a4a', blurb: '5 players. A shot at a silver.',
  },
  {
    id: 'silver', name: 'Silver Pack', price: 3500, size: 5,
    odds: { gold: 0.03, silver: 0.7 }, bonusOdds: { gold: 0.3, silver: 1 },
    color: '#b8c2cc', blurb: '5 players. Mostly silver, gold chance.',
  },
  {
    id: 'gold', name: 'Gold Pack', price: 9000, size: 5,
    odds: { elite: 0.005, gold: 0.25, silver: 1 }, bonusOdds: { elite: 0.04, gold: 1 },
    color: '#f5c542', blurb: '5 players. 1 gold guaranteed.',
  },
  {
    id: 'pro', name: 'Pro Pack', price: 25000, size: 6,
    odds: { elite: 0.02, gold: 0.6, silver: 1 }, bonusOdds: { elite: 0.2, gold: 1 },
    color: '#7c4dff', blurb: '6 players. 1 gold+ guaranteed, best elite odds.',
  },
];

function rollTier(rng: Rng, odds: Partial<Record<Tier, number>>): Tier {
  for (const tier of ['elite', 'gold', 'silver'] as Tier[]) {
    const p = odds[tier];
    if (p !== undefined && rng() < p) return tier;
  }
  return 'bronze';
}

export function openPack(rng: Rng, pack: PackDef): PlayerCard[] {
  const cards: PlayerCard[] = [];
  for (let i = 0; i < pack.size; i++) {
    const tier = rollTier(rng, i === pack.size - 1 ? pack.bonusOdds : pack.odds);
    cards.push(generateForTier(rng, tier));
  }
  // Reveal order: worst first, best last.
  return cards.sort((a, b) => a.ovr - b.ovr);
}
