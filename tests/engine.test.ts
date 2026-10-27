import { describe, expect, it } from 'vitest';
import { PlayEngine, fieldGoalChance, kickDistance } from '../src/game/engine';
import { DEFENSE_PLAYBOOK, OFFENSE_PLAYBOOK } from '../src/game/plays';
import { generateCpuRoster } from '../src/data/lineup';
import { generatePlayer } from '../src/data/players';
import { makeRng } from '../src/data/rng';

function simulate(seed: number, offOvr: number, defOvr: number, offId: string, defId: string) {
  const rng = makeRng(seed);
  const engine = new PlayEngine({
    los: 30,
    offense: generateCpuRoster(rng, offOvr),
    defense: generateCpuRoster(rng, defOvr),
    offPlay: OFFENSE_PLAYBOOK.find((p) => p.id === offId)!,
    defPlay: DEFENSE_PLAYBOOK.find((p) => p.id === defId)!,
    userSide: 'def', // with no input, both sides are AI-driven
    rng,
  });
  let steps = 0;
  while (!engine.over && steps < 2000) {
    engine.step(1 / 60, { move: null, sprint: false });
    steps++;
  }
  return engine;
}

describe('PlayEngine', () => {
  it('always resolves every play combination', () => {
    let seed = 1;
    for (const o of OFFENSE_PLAYBOOK) {
      for (const d of DEFENSE_PLAYBOOK) {
        for (let i = 0; i < 4; i++) {
          const e = simulate(seed++, 70, 70, o.id, d.id);
          expect(e.over).toBe(true);
          expect(e.outcome).not.toBeNull();
        }
      }
    }
  });

  it('produces a believable spread of results between even teams', () => {
    const kinds: Record<string, number> = {};
    let yards = 0;
    let n = 0;
    let seed = 1000;
    for (const o of OFFENSE_PLAYBOOK) {
      for (const d of DEFENSE_PLAYBOOK) {
        for (let i = 0; i < 12; i++) {
          const e = simulate(seed++, 70, 70, o.id, d.id);
          kinds[e.outcome!.kind] = (kinds[e.outcome!.kind] ?? 0) + 1;
          yards += e.outcome!.yards;
          n++;
        }
      }
    }
    const avg = yards / n;
    // eslint-disable-next-line no-console
    console.log('outcomes', kinds, 'avg yards', avg.toFixed(2));
    expect(avg).toBeGreaterThan(2);
    expect(avg).toBeLessThan(14);
    expect((kinds.td ?? 0) / n).toBeLessThan(0.2);
    expect((kinds.int ?? 0) / n).toBeLessThan(0.12);
  });

  it('rewards the better team', () => {
    const avgYards = (offOvr: number, defOvr: number) => {
      let total = 0;
      let n = 0;
      let seed = 5000;
      for (const o of OFFENSE_PLAYBOOK) {
        for (const d of DEFENSE_PLAYBOOK) {
          for (let i = 0; i < 8; i++) {
            total += simulate(seed++, offOvr, defOvr, o.id, d.id).outcome!.yards;
            n++;
          }
        }
      }
      return total / n;
    };
    expect(avgYards(85, 55)).toBeGreaterThan(avgYards(55, 85));
  });
});

describe('field goals', () => {
  it('gets harder with distance and is impossible out of range', () => {
    const k = generatePlayer(makeRng(3), 'K', 80);
    expect(kickDistance(75)).toBe(42);
    expect(fieldGoalChance(k, 25)).toBeGreaterThan(fieldGoalChance(k, 50));
    expect(fieldGoalChance(k, 80)).toBe(0);
  });
});
