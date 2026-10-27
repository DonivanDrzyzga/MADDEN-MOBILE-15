import { describe, expect, it } from 'vitest';
import { Store, MAX_STAMINA, STAMINA_REGEN_MS, SAVE_KEY } from '../src/state/store';
import { PACKS } from '../src/data/packs';
import { ALL_SLOTS, SLOT_POSITION } from '../src/data/lineup';
import { makeRng } from '../src/data/rng';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('Store', () => {
  it('starts with a full, valid lineup', () => {
    const s = new Store(memoryStorage(), makeRng(1));
    for (const slot of ALL_SLOTS) {
      const id = s.data.lineup[slot]!;
      expect(s.data.cards.find((c) => c.id === id)!.pos).toBe(SLOT_POSITION[slot]);
    }
    expect(new Set(Object.values(s.data.lineup)).size).toBe(ALL_SLOTS.length);
  });

  it('persists and reloads', () => {
    const st = memoryStorage();
    const a = new Store(st, makeRng(1));
    a.data.coins = 1234;
    a.save();
    expect(st.m.has(SAVE_KEY)).toBe(true);
    expect(new Store(st, makeRng(2)).data.coins).toBe(1234);
  });

  it('buys packs only with enough coins', () => {
    const s = new Store(memoryStorage(), makeRng(1));
    const before = s.data.cards.length;
    const cards = s.buyPack(PACKS[0])!;
    expect(cards).toHaveLength(PACKS[0].size);
    expect(s.data.cards.length).toBe(before + PACKS[0].size);
    s.data.coins = 0;
    expect(s.buyPack(PACKS[0])).toBeNull();
  });

  it('refuses to quick sell starters', () => {
    const s = new Store(memoryStorage(), makeRng(1));
    const starter = s.data.lineup.QB!;
    expect(s.quickSell(starter)).toBe(0);
    const bench = s.data.cards.find((c) => !s.isInLineup(c.id))!;
    const coins = s.data.coins;
    expect(s.quickSell(bench.id)).toBeGreaterThan(0);
    expect(s.data.coins).toBeGreaterThan(coins);
  });

  it('swaps players between slots', () => {
    const s = new Store(memoryStorage(), makeRng(1));
    const wr1 = s.data.lineup.WR1!;
    const wr2 = s.data.lineup.WR2!;
    expect(s.setSlot('WR1', wr2)).toBe(true);
    expect(s.data.lineup.WR1).toBe(wr2);
    expect(s.data.lineup.WR2).toBe(wr1);
    expect(s.setSlot('QB', wr1)).toBe(false); // wrong position
  });

  it('regenerates stamina over time and levels up', () => {
    const s = new Store(memoryStorage(), makeRng(1));
    const t0 = Date.now();
    expect(s.spendStamina(10, t0)).toBe(true);
    expect(s.data.stamina).toBe(MAX_STAMINA - 10);
    s.tickStamina(t0 + STAMINA_REGEN_MS * 3 + 5);
    expect(s.data.stamina).toBe(MAX_STAMINA - 7);
    expect(s.reward(0, 10_000)).toBeGreaterThan(0);
    expect(s.data.stamina).toBe(MAX_STAMINA);
  });
});
