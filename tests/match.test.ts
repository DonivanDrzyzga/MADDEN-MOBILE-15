import { describe, expect, it } from 'vitest';
import { Match, spotLabel } from '../src/game/match';
import { PlayOutcome } from '../src/game/engine';
import { generateCpuRoster } from '../src/data/lineup';
import { LIVE_EVENTS } from '../src/data/events';
import { makeRng } from '../src/data/rng';

const rng = makeRng(42);
const user = generateCpuRoster(rng, 70, 'Users');
const cpu = generateCpuRoster(rng, 70, 'Cpu');
const tackle = (endY: number, los: number): PlayOutcome => ({ kind: 'tackle', endY, yards: endY - los, text: '' });

describe('Match', () => {
  it('tracks downs, first downs and turnover on downs', () => {
    const m = new Match({ kind: 'season', userRoster: user, cpuRoster: cpu, cpuName: 'Cpu' }, rng);
    expect(m.drive.los).toBe(25);
    m.applyPlay(tackle(29, 25));
    expect([m.drive.down, m.drive.toGo]).toEqual([2, 6]);
    m.applyPlay(tackle(36, 29));
    expect([m.drive.down, m.drive.toGo, m.drive.los]).toEqual([1, 10, 36]);
    for (let i = 0; i < 3; i++) m.applyPlay({ kind: 'incomplete', endY: 36, yards: 0, text: '' });
    expect(m.drive.down).toBe(4);
    const r = m.applyPlay({ kind: 'incomplete', endY: 36, yards: 0, text: '' });
    expect(r.driveOver).toBe(true);
    expect(m.drive.result).toBe('downs');
    // Next possession: CPU takes over where the user turned it over (their 64).
    expect(m.nextPossession()).toBe(true);
    expect(m.drive.side).toBe('def');
    expect(m.drive.los).toBe(64);
  });

  it('credits touchdowns to the right team', () => {
    const m = new Match({ kind: 'season', userRoster: user, cpuRoster: cpu, cpuName: 'Cpu' }, rng);
    m.applyPlay({ kind: 'td', endY: 100, yards: 75, text: '' });
    expect(m.userScore).toBe(7);
    m.nextPossession();
    m.applyPlay({ kind: 'td', endY: 100, yards: 75, text: '' });
    expect(m.cpuScore).toBe(7);
  });

  it('plays a fixed number of possessions and never ends tied', () => {
    const m = new Match({ kind: 'season', userRoster: user, cpuRoster: cpu, cpuName: 'Cpu' }, rng);
    let n = 1;
    while (m.nextPossession()) n++;
    expect(n).toBe(m.possessions.length);
    expect(m.userScore).not.toBe(m.cpuScore);
  });

  it('judges live event goals', () => {
    const td = LIVE_EVENTS.find((e) => e.goal === 'td')!;
    const m = new Match({ kind: 'event', userRoster: user, cpuRoster: cpu, cpuName: 'Cpu', scenario: td }, rng);
    for (let i = 0; i < td.plays; i++) m.applyPlay(tackle(m.drive.los + 1, m.drive.los));
    expect(m.drive.over).toBe(true);
    expect(m.eventWon()).toBe(false);

    const stop = LIVE_EVENTS.find((e) => e.id === 'goal-line')!;
    const d = new Match({ kind: 'event', userRoster: user, cpuRoster: cpu, cpuName: 'Cpu', scenario: stop }, rng);
    expect(d.toGoLabel).toBe('Goal');
    d.applyPlay({ kind: 'int', endY: 95, yards: 0, text: '' });
    expect(d.eventWon()).toBe(true);
  });

  it('labels field position from the user perspective', () => {
    expect(spotLabel(25, true)).toBe('OWN 25');
    expect(spotLabel(75, true)).toBe('OPP 25');
    expect(spotLabel(25, false)).toBe('OPP 25');
    expect(spotLabel(50, false)).toBe('50');
  });
});
