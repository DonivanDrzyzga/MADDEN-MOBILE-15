import { describe, expect, it } from 'vitest';
import { PlayEngine, SPIN_TIME, Actor, massFor } from '../src/game/engine';
import { DEFENSE_PLAYBOOK, OFFENSE_PLAYBOOK } from '../src/game/plays';
import { generateCpuRoster } from '../src/data/lineup';
import { generatePlayer } from '../src/data/players';
import { makeRng } from '../src/data/rng';

/** A run play with the user carrying the ball in open field and every defender parked far away. */
function openField(seed = 1) {
  const rng = makeRng(seed);
  const e = new PlayEngine({
    los: 30,
    offense: generateCpuRoster(rng, 75),
    defense: generateCpuRoster(rng, 75),
    offPlay: OFFENSE_PLAYBOOK.find((p) => p.id === 'dive')!,
    defPlay: DEFENSE_PLAYBOOK[0],
    userSide: 'off',
    rng,
  });
  for (let i = 0; i < 40; i++) e.step(1 / 60, { move: { x: 0, y: 1 }, sprint: false });
  const hb = e.carrier()!;
  expect(hb.slot).toBe('HB');
  // Move the play into open grass so nothing interferes.
  for (const a of e.actors) {
    if (a === hb) continue;
    a.x = a.side === 'def' ? 50 : 3;
    a.y = 90;
    a.vx = a.vy = 0;
    a.stun = 99;
    a.engaged = null;
  }
  hb.engaged = null;
  hb.x = 26;
  hb.y = 40;
  return { e, hb };
}

function run(e: PlayEngine, secs: number, move = { x: 0, y: 1 }, sprint = false) {
  for (let t = 0; t < secs; t += 1 / 60) e.step(1 / 60, { move, sprint });
}

const speed = (a: Actor) => Math.hypot(a.vx, a.vy);

describe('physics movement', () => {
  it('builds speed over time instead of instantly', () => {
    const { e, hb } = openField();
    hb.vx = hb.vy = 0;
    run(e, 0.25);
    const early = speed(hb);
    run(e, 1.5);
    expect(early).toBeLessThan(hb.speed * 0.6);
    expect(speed(hb)).toBeGreaterThan(hb.speed * 0.85);
  });

  it('cannot reverse direction on a dime at full speed', () => {
    const { e, hb } = openField();
    run(e, 1.5);
    const before = hb.vy;
    run(e, 0.12, { x: 0, y: -1 });
    // Still moving downfield after a tenth of a second: momentum carries him.
    expect(hb.vy).toBeGreaterThan(before * 0.4);
  });

  it('carves a wider arc at speed than from a jog', () => {
    const turnAfter = (startSpeed: number) => {
      const { e, hb } = openField();
      hb.vx = 0;
      hb.vy = startSpeed;
      run(e, 0.2, { x: 1, y: 0 });
      return Math.atan2(hb.vx, hb.vy); // radians turned toward the right
    };
    expect(turnAfter(2.5)).toBeGreaterThan(turnAfter(7.5));
  });
});

describe('skill moves', () => {
  it('spin turns a full circle and keeps most of the momentum', () => {
    const { e, hb } = openField();
    run(e, 1.5);
    const v0 = speed(hb);
    e.spin();
    expect(hb.spinT).toBe(0);
    run(e, SPIN_TIME * 0.5);
    expect(hb.spinT).toBeGreaterThan(0);
    run(e, SPIN_TIME * 0.6);
    expect(hb.spinT).toBe(-1);
    expect(speed(hb)).toBeGreaterThan(v0 * 0.55);
    expect(hb.vy).toBeGreaterThan(0);
  });

  it('juke trades forward speed for a sideways burst', () => {
    const { e, hb } = openField();
    run(e, 1.5);
    const vy0 = hb.vy;
    e.juke();
    expect(Math.abs(hb.vx)).toBeGreaterThan(3.5);
    expect(hb.vy).toBeLessThan(vy0 * 0.7);
  });

  it('heavier, faster runners win more trucks', () => {
    const winRate = (runnerMass: number, runSpeed: number) => {
      let wins = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const { e, hb } = openField(seed);
        hb.mass = runnerMass;
        const d = e.def[0];
        d.card = generatePlayer(makeRng(seed), 'LB', 75);
        d.mass = massFor(d.card);
        d.stun = 0;
        d.x = hb.x;
        d.y = hb.y + 1.0;
        d.vx = 0;
        d.vy = -3;
        hb.vx = 0;
        hb.vy = runSpeed;
        e.truck();
        e.step(1 / 60, { move: { x: 0, y: 1 }, sprint: false });
        if (!e.over && d.down > 0) wins++;
      }
      return wins / 60;
    };
    expect(winRate(115, 8)).toBeGreaterThan(winRate(85, 3) + 0.15);
  });
});
