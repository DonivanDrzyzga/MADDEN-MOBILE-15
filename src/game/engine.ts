import { PlayerCard } from '../data/players';
import { Roster, Slot, OFFENSE_SLOTS, DEFENSE_SLOTS } from '../data/lineup';
import { Rng, clamp } from '../data/rng';
import { DefAssign, DefPlay, OffPlay, OFF_ALIGN, DEF_ALIGN, Receiver } from './plays';

/**
 * Real-time play simulation. World coordinates are in yards and always relative to the offense:
 * y runs from the offense's own goal line (0) to the opponent's goal line (100); x runs sideline
 * to sideline (0..FIELD_W). The ball is snapped from the middle of the field.
 */
export const FIELD_W = 53.3;
export const CENTER_X = FIELD_W / 2;
const MAX_PLAY_TIME = 16;

export interface Vec { x: number; y: number }
export type Side = 'off' | 'def';

export interface Actor {
  id: number;
  side: Side;
  slot: Slot;
  card: PlayerCard;
  x: number; y: number; vx: number; vy: number;
  speed: number;
  accel: number;
  /** Body mass in kg; drives momentum in collisions, blocks and tackles. */
  mass: number;
  /** Acceleration from the last step (yd/s^2), used to lean and bank the 3D body. */
  ax: number;
  ay: number;
  route: Vec[] | null;
  routeIdx: number;
  sit: boolean;
  blocker: boolean;
  assign: DefAssign | null;
  engaged: Actor | null;
  shedImmune: number;
  stun: number;
  tackleCd: number;
  react: number; // countdown before a defender reacts to a throw / handoff (-1 = not triggered)
  evade: number; // ball carrier: time left in a juke/spin window
  truck: number;
  moveCd: number;
  /** Seconds into a spin move (-1 when not spinning) and its turn direction (+1 counter-clockwise). */
  spinT: number;
  spinDir: number;
  /** Seconds into a juke plant (-1 when not juking) and the side of the cut (+1 = carrier's left). */
  jukeT: number;
  jukeDir: number;
  /** Lost balance after contact: weaker cuts and a slower top end. */
  stumble: number;
  dive: number;
  /** Time left on the ground, and the direction the body fell. */
  down: number;
  downDir: Vec;
}

export type OutcomeKind = 'tackle' | 'sack' | 'oob' | 'td' | 'incomplete' | 'int' | 'fumble' | 'safety';

export interface PlayOutcome {
  kind: OutcomeKind;
  endY: number;
  yards: number;
  text: string;
}

export type Ball =
  | { state: 'held'; carrier: Actor }
  | { state: 'air'; from: Vec; to: Vec; t: number; dur: number; target: Actor }
  | { state: 'dead'; at: Vec };

export interface PlaySetup {
  los: number;
  offense: Roster;
  defense: Roster;
  offPlay: OffPlay;
  defPlay: DefPlay;
  userSide: Side;
  rng: Rng;
}

export interface Input {
  /** Desired movement in world space (length 0..1), or null when the stick is released. */
  move: Vec | null;
  sprint: boolean;
}

export interface FloatText { text: string; x: number; y: number; t: number }

export const SPIN_TIME = 0.5;
export const JUKE_TIME = 0.32;

const speedFor = (spd: number) => 2.2 + spd * 0.075;

/** Typical playing weights (kg); strength adds or removes a little bulk. */
const BASE_MASS: Record<string, number> = { QB: 102, HB: 97, WR: 88, TE: 114, OL: 141, DL: 130, LB: 110, CB: 87, S: 94, K: 86 };
export function massFor(card: PlayerCard): number {
  return BASE_MASS[card.pos] + (card.ratings.str - 70) * 0.35;
}
const len = (x: number, y: number) => Math.hypot(x, y);
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function norm(x: number, y: number): Vec {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

export class PlayEngine {
  readonly actors: Actor[] = [];
  readonly off: Actor[] = [];
  readonly def: Actor[] = [];
  readonly bySlot = new Map<Slot, Actor>();
  ball: Ball;
  t = 0;
  over = false;
  outcome: PlayOutcome | null = null;
  controlled: Actor | null = null;
  thrown = false;
  /** Play clock time when the ball was released (for the throwing animation). */
  throwAt = -1;
  handedOff = false;
  sprintMeter = 1;
  floats: FloatText[] = [];
  readonly los: number;
  readonly offPlay: OffPlay;
  readonly defPlay: DefPlay;
  readonly userSide: Side;
  private rng: Rng;
  private qbReadAt: number;
  private lastMove: Vec | null = null;

  constructor(setup: PlaySetup) {
    this.los = setup.los;
    this.offPlay = setup.offPlay;
    this.defPlay = setup.defPlay;
    this.userSide = setup.userSide;
    this.rng = setup.rng;
    this.qbReadAt = 1.2 + this.rng() * 1.2;
    let id = 0;
    for (const slot of OFFENSE_SLOTS) {
      const [dx, dy] = OFF_ALIGN[slot]!;
      const a = this.makeActor(id++, 'off', slot, setup.offense[slot], CENTER_X + dx, this.los + dy);
      this.off.push(a);
    }
    for (const slot of DEFENSE_SLOTS) {
      const [dx, dy] = DEF_ALIGN[slot]!;
      // Near the goal line the secondary is squeezed into the end zone.
      const a = this.makeActor(id++, 'def', slot, setup.defense[slot], CENTER_X + dx, Math.min(this.los + dy, 108 - (14 - Math.min(dy, 14)) * 0.4));
      a.assign = setup.defPlay.assign[slot] ?? { kind: 'zone', x: dx, y: dy + 5 };
      this.def.push(a);
    }
    this.actors.push(...this.off, ...this.def);
    this.setupAssignments();
    const qb = this.slot('QB');
    this.ball = { state: 'held', carrier: qb };
    if (this.userSide === 'off') this.controlled = qb;
    else this.controlled = this.slot('MLB');
  }

  private makeActor(id: number, side: Side, slot: Slot, card: PlayerCard, x: number, y: number): Actor {
    const a: Actor = {
      id, side, slot, card, x, y, vx: 0, vy: 0,
      speed: speedFor(card.ratings.spd),
      accel: 7 + card.ratings.agi * 0.05,
      mass: massFor(card),
      ax: 0, ay: 0,
      route: null, routeIdx: 0, sit: false, blocker: false,
      assign: null, engaged: null, shedImmune: 0, stun: 0, tackleCd: 0, react: -1,
      evade: 0, truck: 0, moveCd: 0, spinT: -1, spinDir: 1, jukeT: -1, jukeDir: 1, stumble: 0,
      dive: 0, down: 0, downDir: { x: 0, y: 1 },
    };
    this.bySlot.set(slot, a);
    return a;
  }

  slot(s: Slot): Actor {
    return this.bySlot.get(s)!;
  }

  private receiverActor(r: Receiver): Actor {
    return this.slot(r);
  }

  private setupAssignments(): void {
    const play = this.offPlay;
    for (const a of this.off) {
      if (['LT', 'LG', 'C', 'RG', 'RT'].includes(a.slot)) a.blocker = true;
    }
    if (play.type === 'pass') {
      for (const r of ['WR1', 'WR2', 'WR3', 'TE', 'HB'] as Receiver[]) {
        const a = this.receiverActor(r);
        const pts = play.routes?.[r];
        if (!pts) {
          a.blocker = true;
          continue;
        }
        a.route = pts.map(([dx, dy]) => ({ x: clamp(a.x + dx, 1, FIELD_W - 1), y: a.y + dy }));
        const n = pts.length;
        const last = pts[n - 1];
        const prev = n > 1 ? pts[n - 2] : [0, 0];
        a.sit = len(last[0] - prev[0], last[1] - prev[1]) < 3;
      }
      // Play action: the back carries out a fake before picking up a blitzer.
      if (play.playAction && !play.routes?.HB) this.slot('HB').route = [{ x: CENTER_X + 2, y: this.los - 2 }];
    } else {
      for (const r of ['WR1', 'WR2', 'WR3', 'TE'] as Receiver[]) this.receiverActor(r).blocker = true;
    }
  }

  // ---------------------------------------------------------------- queries

  carrier(): Actor | null {
    return this.ball.state === 'held' ? this.ball.carrier : null;
  }

  ballPos(): { x: number; y: number; h: number } {
    const b = this.ball;
    if (b.state === 'held') return { x: b.carrier.x, y: b.carrier.y, h: 0 };
    if (b.state === 'dead') return { x: b.at.x, y: b.at.y, h: 0 };
    const k = b.t / b.dur;
    return {
      x: b.from.x + (b.to.x - b.from.x) * k,
      y: b.from.y + (b.to.y - b.from.y) * k,
      h: 4 * k * (1 - k) * Math.min(12, dist(b.from, b.to) * 0.25),
    };
  }

  /** True while the QB still has the ball behind the line on a pass play. */
  canThrow(): boolean {
    const c = this.carrier();
    return !this.over && this.offPlay.type === 'pass' && !this.thrown && !!c && c.slot === 'QB' && c.y <= this.los && this.t > 0.35;
  }

  eligibleReceivers(): Actor[] {
    return this.off.filter((a) => a.route !== null && a.slot !== 'QB' && !(this.offPlay.playAction && a.slot === 'HB' && !this.offPlay.routes?.HB));
  }

  // ---------------------------------------------------------------- user actions

  throwTo(target: Actor): boolean {
    if (!this.canThrow()) return false;
    const qb = this.carrier()!;
    const r = qb.card.ratings;
    const ballSpeed = 17 + r.thp * 0.13;
    // Lead the receiver: iterate the intercept estimate twice.
    let to: Vec = { x: target.x, y: target.y };
    let dur = 0.3;
    for (let i = 0; i < 3; i++) {
      dur = Math.max(0.3, dist(qb, to) / ballSpeed);
      const dir = this.routeDir(target);
      const v = target.sit && target.route && target.routeIdx >= target.route.length ? 0 : target.speed * 0.95;
      to = { x: target.x + dir.x * v * dur, y: target.y + dir.y * v * dur };
    }
    const pressured = this.def.some((d) => dist(d, qb) < 2.5 && !d.engaged);
    const d = dist(qb, to);
    const err = ((1 - r.tha / 100) * 3.2 + Math.max(0, d - 20) * 0.075) * (pressured ? 1.7 : 1) * this.rng();
    const ang = this.rng() * Math.PI * 2;
    to = { x: clamp(to.x + Math.cos(ang) * err, -2, FIELD_W + 2), y: to.y + Math.sin(ang) * err };
    dur = Math.max(0.3, dist(qb, to) / ballSpeed);
    this.ball = { state: 'air', from: { x: qb.x, y: qb.y }, to, t: 0, dur, target };
    this.thrown = true;
    this.throwAt = this.t;
    for (const dfn of this.def) dfn.react = 0.12 + (100 - dfn.card.ratings.cov) * 0.006 + this.rng() * 0.15;
    if (this.userSide === 'off') this.controlled = target;
    return true;
  }

  private carrierCanMove(): Actor | null {
    const c = this.carrier();
    if (!c || this.over || c.moveCd > 0 || c.stun > 0 || c.down > 0 || c.spinT >= 0 || c.jukeT >= 0) return null;
    if (c.slot === 'QB' && this.canThrow() && this.offPlay.type === 'pass') return null;
    return c;
  }

  /** Unit vector of travel (or downfield when standing still). */
  private heading(a: Actor): Vec {
    const s = len(a.vx, a.vy);
    return s > 0.5 ? { x: a.vx / s, y: a.vy / s } : { x: 0, y: a.side === 'off' ? 1 : -1 };
  }

  /** +1 = cut to the carrier's left, -1 = right: the stick decides if pushed sideways, else away from the nearest defender. */
  private cutSide(c: Actor): number {
    const fwd = this.heading(c);
    const left = { x: -fwd.y, y: fwd.x };
    const m = c === this.controlled ? this.lastMove : null;
    if (m) {
      const lat = m.x * left.x + m.y * left.y;
      if (Math.abs(lat) > 0.3) return Math.sign(lat);
    }
    const near = this.nearestDefender(c);
    if (near) return (near.x - c.x) * left.x + (near.y - c.y) * left.y > 0 ? -1 : 1;
    return 1;
  }

  /** Juke: plant the outside foot and cut. Bleeds forward speed for a burst of lateral speed. */
  juke(): void {
    const c = this.carrierCanMove();
    if (!c) return;
    const fwd = this.heading(c);
    const side = this.cutSide(c);
    const left = { x: -fwd.y, y: fwd.x };
    const s = len(c.vx, c.vy);
    const agi = c.card.ratings.agi;
    const lateral = (3.8 + agi * 0.04) * clamp(100 / c.mass, 0.8, 1.15);
    const keep = 0.42 + agi * 0.002;
    c.vx = fwd.x * s * keep + left.x * side * lateral;
    c.vy = fwd.y * s * keep + left.y * side * lateral;
    c.jukeT = 0;
    c.jukeDir = side;
    c.evade = 0.22 + agi * 0.003;
    c.moveCd = 0.75;
    this.float('JUKE', c);
  }

  /** Spin: a full 360 that keeps most of the runner's momentum and curls away from contact. */
  spin(): void {
    const c = this.carrierCanMove();
    if (!c) return;
    c.spinT = 0;
    // Spin away from the defender: turning toward the open side.
    c.spinDir = this.cutSide(c);
    c.evade = SPIN_TIME * 0.9;
    c.moveCd = 0.9;
    this.float('SPIN', c);
  }

  /** Truck: lower the shoulder. The next collision is decided by momentum and strength. */
  truck(): void {
    const c = this.carrierCanMove();
    if (!c) return;
    c.truck = 0.6;
    c.moveCd = 0.9;
    this.float('TRUCK', c);
  }

  /** Defense: lunge at the ball carrier. A miss leaves the defender on the turf. */
  dive(): void {
    const me = this.controlled;
    const c = this.carrier() ?? (this.ball.state === 'air' ? this.ball.target : null);
    if (!me || me.side !== 'def' || this.over || me.stun > 0 || me.dive > 0 || me.down > 0 || me.engaged || !c) return;
    const dir = norm(c.x + c.vx * 0.15 - me.x, c.y + c.vy * 0.15 - me.y);
    const s = Math.max(len(me.vx, me.vy), me.speed * 0.7) + 3;
    me.vx = dir.x * s;
    me.vy = dir.y * s;
    me.dive = 0.42;
  }

  /** Defense: take control of the defender closest to the ball. */
  switchPlayer(): void {
    if (this.userSide !== 'def') return;
    const b = this.ballPos();
    let best: Actor | null = null;
    let bd = Infinity;
    for (const d of this.def) {
      if (d === this.controlled) continue;
      const dd = dist(d, b);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (best) this.controlled = best;
  }

  // ---------------------------------------------------------------- simulation

  step(dt: number, input: Input): void {
    if (this.over) {
      // After the whistle bodies keep sliding and players pull up, so tackles land with weight.
      for (const a of this.actors) {
        const f = Math.exp(-(a.down > 0 ? 3.5 : 2.2) * dt);
        a.vx *= f;
        a.vy *= f;
        a.x += a.vx * dt;
        a.y += a.vy * dt;
        a.ax = 0;
        a.ay = 0;
        if (a.spinT >= 0) a.spinT = a.spinT + dt > SPIN_TIME ? -1 : a.spinT + dt;
      }
      this.updateFloats(dt);
      return;
    }
    this.t += dt;
    const carrier = this.carrier();

    // Run plays: hand off / pitch to the back.
    if (this.offPlay.type === 'run' && !this.handedOff && this.t >= (Math.abs(this.offPlay.hole ?? 0) > 9 ? 0.3 : 0.5)) {
      const hb = this.slot('HB');
      this.ball = { state: 'held', carrier: hb };
      this.handedOff = true;
      for (const d of this.def) d.react = 0.1 + (100 - Math.max(d.card.ratings.tak, d.card.ratings.cov)) * 0.006 + this.rng() * 0.15;
      if (this.userSide === 'off') this.controlled = hb;
    }

    this.lastMove = input.move;
    // Sprint meter.
    const sprinting = input.sprint && this.sprintMeter > 0 && this.userSide === 'off';
    this.sprintMeter = clamp(this.sprintMeter + (sprinting ? -0.4 : 0.18) * dt, 0, 1);

    for (const a of this.actors) {
      a.stun = Math.max(0, a.stun - dt);
      a.tackleCd = Math.max(0, a.tackleCd - dt);
      a.shedImmune = Math.max(0, a.shedImmune - dt);
      a.evade = Math.max(0, a.evade - dt);
      a.truck = Math.max(0, a.truck - dt);
      a.moveCd = Math.max(0, a.moveCd - dt);
      a.stumble = Math.max(0, a.stumble - dt);
      if (a.dive > 0) {
        a.dive = Math.max(0, a.dive - dt);
        // A dive that doesn't connect ends with the defender on the ground.
        if (a.dive === 0 && !this.over) this.knockDown(a, this.heading(a), 0.7);
      }
      if (a.down > 0) {
        a.down = Math.max(0, a.down - dt);
        if (a.down === 0) a.stun = Math.max(a.stun, 0.3); // getting back up
      }
      if (a.jukeT >= 0) a.jukeT = a.jukeT + dt > JUKE_TIME ? -1 : a.jukeT + dt;
      if (a.react > 0) a.react = Math.max(0, a.react - dt);
    }

    this.updateBlocks(dt);

    for (const a of this.actors) {
      const vx0 = a.vx;
      const vy0 = a.vy;
      this.moveActor(a, dt, input, carrier, sprinting);
      a.ax = (a.vx - vx0) / dt;
      a.ay = (a.vy - vy0) / dt;
    }

    for (const a of this.actors) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
    }
    this.separate();

    if (this.ball.state === 'air') this.updatePass(dt);
    if (!this.over) this.checkCarrier();
    if (!this.over && this.t > MAX_PLAY_TIME) {
      const c = this.carrier();
      this.end(c && c.slot === 'QB' && this.offPlay.type === 'pass' ? 'sack' : 'tackle', c ? c.y : this.los);
    }
    this.updateFloats(dt);
  }

  private moveActor(a: Actor, dt: number, input: Input, carrier: Actor | null, sprinting: boolean): void {
    if (a.down > 0) {
      // On the ground: slide to a stop.
      const f = Math.exp(-4 * dt);
      a.vx *= f;
      a.vy *= f;
      return;
    }
    if (a.dive > 0) {
      // Airborne: momentum only, a little drag.
      a.vx *= Math.exp(-1.2 * dt);
      a.vy *= Math.exp(-1.2 * dt);
      return;
    }
    if (a.spinT >= 0) {
      this.spinStep(a, dt);
      return;
    }
    if (a.stun > 0) {
      const f = Math.exp(-5 * dt);
      a.vx *= f;
      a.vy *= f;
      return;
    }
    if (a.engaged) return; // handled in updateBlocks
    const userHere = a === this.controlled && !!input.move && a.side === this.userSide;
    let desired: Vec;
    let maxSpeed = a.speed;
    if (userHere && !(a.slot === 'QB' && this.ball.state === 'air')) {
      desired = { x: input.move!.x, y: input.move!.y };
      if (a === carrier && sprinting) maxSpeed *= 1.1;
    } else {
      desired = this.ai(a);
    }
    if (a === carrier) maxSpeed *= 0.94; // carrying the ball costs a step
    else if (carrier && a.side !== carrier.side && a.y < carrier.y && dist(a, carrier) < 4) maxSpeed *= 1.07; // chase-down burst
    if (a.truck > 0) maxSpeed *= 0.93;
    if (a.stumble > 0) maxSpeed *= 0.8;
    // Mid-juke the runner is committed to the cut; the stick only matters again once the foot is down.
    const committed = a.jukeT >= 0 && a.jukeT < JUKE_TIME * 0.7;
    if (committed) desired = this.heading(a);
    this.drive(a, desired, maxSpeed, dt, a === carrier && sprinting, committed);
  }

  /**
   * Momentum-based locomotion: acceleration tapers near top speed, braking has its own limit,
   * and lateral (turning) acceleration is capped, so fast players carve arcs instead of
   * snapping to a new direction. Lighter, more agile players turn and stop quicker.
   */
  private drive(a: Actor, desired: Vec, maxSpeed: number, dt: number, sprinting: boolean, committed: boolean): void {
    const agi = a.card.ratings.agi;
    const light = clamp(100 / a.mass, 0.72, 1.15);
    const tvx = desired.x * maxSpeed;
    const tvy = desired.y * maxSpeed;
    const s = len(a.vx, a.vy);
    if (s < 0.4) {
      // From a standstill: push off in any direction.
      const acc = a.accel * light * 1.1 * dt;
      const dvx = tvx - a.vx;
      const dvy = tvy - a.vy;
      const dl = len(dvx, dvy);
      if (dl <= acc) { a.vx = tvx; a.vy = tvy; } else { a.vx += (dvx / dl) * acc; a.vy += (dvy / dl) * acc; }
      return;
    }
    const fx = a.vx / s;
    const fy = a.vy / s;
    const along = tvx * fx + tvy * fy;
    const px = tvx - fx * along;
    const py = tvy - fy * along;
    // Longitudinal: strong first steps, slow build to top speed, firm brakes.
    const ratio = Math.min(1, s / a.speed);
    const accCap = a.accel * light * (1 - 0.6 * ratio * ratio) * (sprinting ? 1.1 : 1);
    const brakeCap = (11 + agi * 0.08) * light;
    const dAlong = clamp(along - s, -brakeCap * dt, accCap * dt);
    // Lateral: centripetal limit. Easier at low speed, harder while sprinting or off balance.
    let latCap = (6 + agi * 0.1) * light * (sprinting ? 0.7 : 1) * (a.stumble > 0 ? 0.45 : 1) * (committed ? 0.15 : 1);
    latCap *= 1 + 2.2 * Math.max(0, 1 - s / 3);
    const pl = len(px, py);
    const lat = Math.min(pl, latCap * dt);
    const ns = Math.max(0, s + dAlong);
    a.vx = fx * ns + (pl > 1e-6 ? (px / pl) * lat : 0);
    a.vy = fy * ns + (pl > 1e-6 ? (py / pl) * lat : 0);
  }

  /** Spin physics: the body rotates through 360 while momentum carries on, bending away from contact. */
  private spinStep(a: Actor, dt: number): void {
    const s = len(a.vx, a.vy);
    const t0 = a.spinT;
    a.spinT += dt;
    // Planting for the spin costs speed early; the runner holds what's left through the turn.
    const target = a.speed * (0.62 + a.card.ratings.agi * 0.002);
    const ns = s > target ? Math.max(target, s - 9 * dt) : Math.min(target, s + 3 * dt);
    // Curl the path around the defender: up to ~40 degrees over the move.
    const curl = a.spinDir * 0.7 * (Math.min(a.spinT, SPIN_TIME) - t0) / SPIN_TIME;
    const h = this.heading(a);
    const c = Math.cos(curl);
    const sn = Math.sin(curl);
    a.vx = (h.x * c - h.y * sn) * ns;
    a.vy = (h.x * sn + h.y * c) * ns;
    if (a.spinT >= SPIN_TIME) {
      a.spinT = -1;
      a.stumble = Math.max(a.stumble, 0.15);
    }
  }

  /** Put a player on the ground, falling along `dir`. */
  private knockDown(a: Actor, dir: Vec, time: number): void {
    a.down = Math.max(a.down, time);
    a.downDir = norm(dir.x, dir.y);
    a.dive = 0;
    a.spinT = -1;
    a.jukeT = -1;
    if (a.engaged) {
      a.engaged.engaged = null;
      a.engaged = null;
    }
  }

  private updateFloats(dt: number): void {
    for (const f of this.floats) f.t += dt;
    this.floats = this.floats.filter((f) => f.t < 1.2);
  }

  private float(text: string, at: Vec): void {
    this.floats.push({ text, x: at.x, y: at.y, t: 0 });
  }

  private nearestDefender(c: Vec): Actor | null {
    let best: Actor | null = null;
    let bd = Infinity;
    for (const d of this.def) {
      const dd = dist(d, c);
      if (dd < bd && d.stun <= 0 && d.down <= 0) { bd = dd; best = d; }
    }
    return best;
  }

  private routeDir(a: Actor): Vec {
    if (a.route && a.routeIdx < a.route.length) {
      const p = a.route[a.routeIdx];
      const d = norm(p.x - a.x, p.y - a.y);
      if (d.x || d.y) return d;
    }
    return norm(a.vx, a.vy);
  }

  // ---------------------------------------------------------------- AI

  private ai(a: Actor): Vec {
    return a.side === 'off' ? this.offenseAi(a) : this.defenseAi(a);
  }

  private offenseAi(a: Actor): Vec {
    const c = this.carrier();
    if (a === c) return a.slot === 'QB' && this.offPlay.type === 'pass' && !this.thrown ? this.qbAi(a) : this.runnerAi(a);
    // Run play before the handoff: the back heads for the mesh point.
    if (this.offPlay.type === 'run' && a.slot === 'HB' && !this.handedOff) {
      return norm(CENTER_X + (this.offPlay.hole ?? 0) * 0.35 - a.x, this.los - 3 - a.y);
    }
    if (a.slot === 'QB') {
      if (this.offPlay.type === 'run') return this.t < 0.8 ? norm(CENTER_X - 1 - a.x, this.los - 5 - a.y) : { x: 0, y: 0 };
      return { x: 0, y: 0 };
    }
    if (this.ball.state === 'air' && a === this.ball.target) {
      const to = this.ball.to;
      const d = dist(a, to);
      return d < 0.3 ? { x: 0, y: 0 } : norm(to.x - a.x, to.y - a.y);
    }
    // Once someone is running with the ball, everyone blocks downfield.
    const runPhase = c && (c.slot !== 'QB' || c.y > this.los) && c.side === 'off';
    if (a.route && !runPhase) return this.routeAi(a);
    if (a.blocker || runPhase) return this.blockSeek(a);
    return { x: 0, y: 0 };
  }

  private routeAi(a: Actor): Vec {
    const route = a.route!;
    while (a.routeIdx < route.length && dist(a, route[a.routeIdx]) < 0.8) a.routeIdx++;
    if (a.routeIdx < route.length) {
      const p = route[a.routeIdx];
      return norm(p.x - a.x, p.y - a.y);
    }
    if (a.sit) {
      // Settle and drift toward the QB a touch, like working back to the ball.
      return { x: 0, y: 0 };
    }
    const n = route.length;
    const prev = n > 1 ? route[n - 2] : { x: route[0].x, y: this.los };
    const dir = norm(route[n - 1].x - prev.x, route[n - 1].y - prev.y);
    if ((a.x < 2 && dir.x < 0) || (a.x > FIELD_W - 2 && dir.x > 0)) return { x: 0, y: 1 };
    return dir;
  }

  private qbAi(a: Actor): Vec {
    const dropTo = this.offPlay.playAction ? 7.5 : 6;
    const userQb = this.userSide === 'off';
    if (!userQb && this.t > 0.35) this.cpuQbRead(a);
    if (this.ball.state !== 'held' || this.ball.carrier !== a) return { x: 0, y: 0 };
    if (this.offPlay.playAction && this.t < 0.6) return norm(CENTER_X + 1.5 - a.x, this.los - 3 - a.y);
    if (a.y > this.los - dropTo) return { x: 0, y: -1 };
    // Step up / slide away from the nearest free rusher.
    const threat = this.def.filter((d) => !d.engaged && dist(d, a) < 4)[0];
    if (threat && Math.abs(a.x - CENTER_X) < 6) return norm(a.x - threat.x, 0.3);
    return { x: 0, y: 0 };
  }

  private cpuQbRead(qb: Actor): void {
    if (!this.canThrow()) return;
    const pressure = this.def.some((d) => !d.engaged && dist(d, qb) < 2.2);
    if (this.t < this.qbReadAt && !pressure) return;
    let best: Actor | null = null;
    let bestScore = -Infinity;
    for (const r of this.eligibleReceivers()) {
      let open = Infinity;
      for (const d of this.def) open = Math.min(open, dist(d, r));
      const score = open + (r.y - this.los) * 0.08;
      if (open > (pressure ? 1.8 : 3.2) && score > bestScore) { best = r; bestScore = score; }
    }
    if (best) this.throwTo(best);
    else if (this.t > this.qbReadAt + 1.6 && pressure) {
      // Throw it away rather than take the sack, most of the time.
      if (this.rng() < 0.03) this.throwAway(qb);
    }
  }

  private throwAway(qb: Actor): void {
    const to = { x: qb.x < CENTER_X ? -3 : FIELD_W + 3, y: qb.y + 8 };
    const target = this.eligibleReceivers()[0] ?? qb;
    this.ball = { state: 'air', from: { x: qb.x, y: qb.y }, to, t: 0, dur: 0.7, target };
    this.thrown = true;
  }

  private runnerAi(a: Actor): Vec {
    let dx = 0;
    let dy = 1;
    const hole = this.offPlay.type === 'run' && a.slot === 'HB' ? CENTER_X + (this.offPlay.hole ?? 0) : null;
    if (hole !== null && a.y < this.los + 1) {
      const toHole = norm(hole - a.x, this.los + 1.5 - a.y);
      dx = toHole.x * 1.5;
      dy = Math.max(0.3, toHole.y);
    }
    for (const d of this.def) {
      if (d.stun > 0 || d.engaged || d.down > 0) continue;
      const rx = d.x - a.x;
      const ry = d.y - a.y;
      const dd = len(rx, ry);
      if (dd < 7 && ry > -1.5) {
        const w = ((7 - dd) / 7) * 1.4;
        dx -= (rx / dd) * w;
        dy -= (ry / dd) * w * 0.5;
      }
      if (dd < 1.8 && ry > 0 && a.moveCd <= 0 && this.userSide !== 'off' && this.rng() < 0.006 + a.card.ratings.agi * 0.00015) {
        if (this.rng() < 0.5) this.juke(); else this.spin();
      }
    }
    if (a.x < 4) dx += (4 - a.x) * 0.4;
    if (a.x > FIELD_W - 4) dx -= (a.x - (FIELD_W - 4)) * 0.4;
    dy = Math.max(dy, 0.25);
    return norm(dx, dy);
  }

  private blockSeek(a: Actor): Vec {
    const c = this.carrier();
    const protect: Vec = c ?? this.slot('QB');
    const range = ['LT', 'LG', 'C', 'RG', 'RT'].includes(a.slot) ? 5 : 8;
    let target: Actor | null = null;
    let bd = Infinity;
    for (const d of this.def) {
      if (d.engaged || d.shedImmune > 0 || d.stun > 0 || d.down > 0) continue;
      const dd = dist(a, d);
      const threat = dist(d, protect);
      const score = dd + threat * 0.35;
      if (dd < range && score < bd) { bd = score; target = d; }
    }
    if (!target) {
      // Pass pro: hold the pocket. Run: climb to the second level.
      if (this.offPlay.type === 'pass' && !this.thrown) return norm(0, Math.min(0, this.los - 1.5 - a.y));
      return c ? norm(c.x + (a.x - c.x) * 0.5 - a.x, c.y + 4 - a.y) : { x: 0, y: 0 };
    }
    const dir = norm(protect.x - target.x, protect.y - target.y);
    return norm(target.x + dir.x * 0.9 - a.x, target.y + dir.y * 0.9 - a.y);
  }

  private defenseAi(a: Actor): Vec {
    const c = this.carrier();
    const ballLive = c && c.side === 'off';
    // Ball in the air: break on it once reacted.
    if (this.ball.state === 'air') {
      if (a.react === 0) {
        const to = this.ball.to;
        if (dist(a, to) < 14 || a.assign?.kind === 'man') return norm(to.x - a.x, to.y - a.y);
        return this.pursue(a, this.ball.target);
      }
      return this.coverAi(a);
    }
    if (!ballLive || !c) return { x: 0, y: 0 };
    // Carrier is a runner (handoff, catch, or QB scramble): pursue after reacting.
    const runner = c.slot !== 'QB' || c.y > this.los + 0.5;
    if (a.assign?.kind === 'rush') return this.pursue(a, c);
    if (runner && (a.react === 0 || (a.react < 0 && c.slot === 'QB'))) return this.pursue(a, c);
    if (this.offPlay.playAction && this.t < 0.7 && a.slot.endsWith('LB')) return { x: 0, y: -1 }; // linebackers bite on the fake
    return this.coverAi(a);
  }

  private coverAi(a: Actor): Vec {
    const as = a.assign;
    if (!as) return { x: 0, y: 0 };
    if (as.kind === 'man') {
      const t = this.receiverActor(as.target);
      if (t.blocker && !t.route) return this.pursue(a, this.carrier() ?? t);
      const lag = 0.25 + (100 - a.card.ratings.cov) * 0.012;
      const aim = { x: t.x + t.vx * 0.3, y: t.y + t.vy * 0.3 + 1.2 - lag };
      const d = dist(a, aim);
      return d < 0.4 ? { x: 0, y: 0 } : norm(aim.x - a.x, aim.y - a.y);
    }
    if (as.kind === 'spy') {
      const qb = this.slot('QB');
      return norm(qb.x - a.x, this.los + 5 - a.y);
    }
    if (as.kind === 'zone') {
      const zx = clamp(CENTER_X + as.x, 2, FIELD_W - 2);
      const zy = Math.min(this.los + as.y, 107);
      const deep = as.y >= 15;
      const radius = deep ? 12 : 7;
      // Pick up the most threatening receiver inside the zone.
      let threat: Actor | null = null;
      let td = Infinity;
      for (const r of this.eligibleReceivers()) {
        const d = Math.hypot(r.x - zx, (r.y - zy) * (deep ? 0.6 : 1));
        if (d < radius && d < td) { td = d; threat = r; }
      }
      const aim = threat
        ? { x: zx + (threat.x - zx) * 0.75, y: deep ? Math.max(zy, threat.y + 4) : zy + (threat.y - zy) * 0.6 }
        : { x: zx, y: zy };
      const d = dist(a, aim);
      return d < 0.5 ? { x: 0, y: 0 } : norm(aim.x - a.x, aim.y - a.y);
    }
    return { x: 0, y: 0 };
  }

  private pursue(a: Actor, t: Actor): Vec {
    const d = dist(a, t);
    const lead = Math.min(1.1, d / a.speed) * 0.8;
    const aim = { x: t.x + t.vx * lead, y: t.y + t.vy * lead };
    return norm(aim.x - a.x, aim.y - a.y);
  }

  // ---------------------------------------------------------------- blocking

  private updateBlocks(dt: number): void {
    const carrier = this.carrier();
    const runPhase = !!carrier && carrier.side === 'off' && (carrier.slot !== 'QB' || carrier.y > this.los);
    // Make new engagements.
    for (const b of this.off) {
      if (b.engaged || b.stun > 0 || b.down > 0 || b === carrier || b.slot === 'QB') continue;
      if (!b.blocker && !runPhase) continue;
      for (const d of this.def) {
        if (d.engaged || d.shedImmune > 0 || d.stun > 0 || d.dive > 0 || d.down > 0) continue;
        if (dist(b, d) < 1.25) {
          b.engaged = d;
          d.engaged = b;
          break;
        }
      }
    }
    // Resolve existing engagements.
    const c = carrier;
    const protect: Vec = c ?? this.slot('QB');
    for (const b of this.off) {
      const d = b.engaged;
      if (!d) continue;
      const pass = this.offPlay.type === 'pass' && !this.thrown && c?.slot === 'QB';
      const dr = d.card.ratings;
      const br = b.card.ratings;
      const defPow = pass && d.card.pos === 'DL' ? dr.prs * 0.7 + dr.str * 0.3 : dr.str * 0.5 + dr.tak * 0.5;
      const blkPow = br.blk * 0.75 + br.str * 0.25;
      // Downfield blocks by skill players are brief; line play is a longer fight.
      const lineman = b.card.pos === 'OL';
      const shedRate = clamp((pass ? 0.24 : 0.35) + (defPow - blkPow) * 0.03, 0.06, 2.2) * (lineman ? (pass ? 1 : 0.5) : 3.5);
      const controlledDef = d === this.controlled;
      if (this.rng() < shedRate * dt * (controlledDef ? 1.6 : 1) || d === c || this.over) {
        b.engaged = null;
        d.engaged = null;
        d.shedImmune = 1.0;
        b.stun = 0.25;
        continue;
      }
      // Run blocks that dominate can put the defender on his back.
      if (!pass && blkPow - defPow > 8 && this.rng() < (blkPow - defPow) * 0.004 * dt * (b.mass / d.mass)) {
        const dir = norm(d.x - b.x, d.y - b.y);
        b.engaged = null;
        d.engaged = null;
        this.knockDown(d, dir, 1.3);
        d.vx = dir.x * 2.5;
        d.vy = dir.y * 2.5;
        this.float('PANCAKE', d);
        continue;
      }
      const dir = norm(protect.x - d.x, protect.y - d.y);
      if (pass) {
        // Pass pro: the rusher walks the blocker back toward the QB. Mass decides who moves whom.
        const push = clamp(0.45 + (defPow - blkPow) * 0.04 + (d.mass - b.mass) * 0.012, 0.1, 2.2);
        d.vx = dir.x * push;
        d.vy = dir.y * push;
      } else {
        // Run block: the blocker turns the defender away from the runner's lane and, if he's
        // winning, drives him off the ball.
        const edge = blkPow - defPow + (b.mass - d.mass) * 0.25;
        const away = d.x >= protect.x ? 1 : -1;
        d.vx = away * clamp(1 + edge * 0.04, 0.3, 2);
        d.vy = clamp(edge * 0.06, -0.8, 1.4);
      }
      b.vx = d.vx;
      b.vy = d.vy;
      // Keep the blocker squared up between the defender and the ball.
      const want = { x: d.x + dir.x * 1.0, y: d.y + dir.y * 1.0 };
      b.x += (want.x - b.x) * Math.min(1, dt * 8);
      b.y += (want.y - b.y) * Math.min(1, dt * 8);
    }
  }

  /**
   * Body-to-body contact: overlapping players are pushed apart in proportion to their mass and
   * exchange a small inelastic impulse, so a linebacker running into a receiver moves him more
   * than the other way round. Players on the ground are stepped over.
   */
  private separate(): void {
    const c = this.carrier();
    const n = this.actors.length;
    for (let i = 0; i < n; i++) {
      const a = this.actors[i];
      if (a.down > 0) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.actors[j];
        if (b.down > 0 || a.engaged === b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const teammates = a.side === b.side;
        // Runners squeeze through gaps between their own blockers.
        const min = (a === c || b === c) ? (teammates ? 0.45 : 0.7) : 0.85;
        if (d <= 0 || d >= min) continue;
        const nx = dx / d;
        const ny = dy / d;
        const ia = 1 / a.mass;
        const ib = 1 / b.mass;
        const overlap = min - d;
        a.x -= nx * overlap * (ia / (ia + ib));
        a.y -= ny * overlap * (ia / (ia + ib));
        b.x += nx * overlap * (ib / (ia + ib));
        b.y += ny * overlap * (ib / (ia + ib));
        // Tackle contact is resolved separately; teammates just slide apart; opponents bump.
        if (teammates || a === c || b === c) continue;
        const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (closing <= 0) continue;
        const jn = (1.15 * closing) / (ia + ib);
        a.vx -= jn * ia * nx;
        a.vy -= jn * ia * ny;
        b.vx += jn * ib * nx;
        b.vy += jn * ib * ny;
      }
    }
  }

  // ---------------------------------------------------------------- pass + tackles

  private updatePass(dt: number): void {
    const b = this.ball;
    if (b.state !== 'air') return;
    b.t += dt;
    if (b.t < b.dur) return;
    const to = b.to;
    const target = b.target;
    if (to.x < 0 || to.x > FIELD_W || to.y > 110) {
      this.end('incomplete', this.los);
      return;
    }
    const dr = dist(target, to);
    let nd: Actor | null = null;
    let dd = Infinity;
    for (const d of this.def) {
      const x = dist(d, to);
      if (x < dd && d.stun <= 0) { dd = x; nd = d; }
    }
    const roll = this.rng();
    const cov = nd ? nd.card.ratings.cov : 50;
    if (dr <= 1.7) {
      const contest = dd < 2 ? (2 - dd) / 2 : 0;
      const pCatch = (0.62 + target.card.ratings.cth * 0.0036) * (1 - contest * (0.25 + cov * 0.004));
      if (roll < pCatch) {
        target.x = to.x;
        target.y = to.y;
        // Securing the catch costs momentum, which gives nearby defenders a chance to close.
        target.vx *= 0.35;
        target.vy *= 0.35;
        this.ball = { state: 'held', carrier: target };
        for (const d of this.def) if (d.react < 0) d.react = 0;
        if (this.userSide === 'off') this.controlled = target;
        this.float('CATCH', target);
        if (target.y >= 100) this.end('td', target.y);
        return;
      }
      if (nd && contest > 0.35 && this.rng() < contest * cov * 0.0035) {
        this.end('int', this.los, nd);
        return;
      }
      this.end('incomplete', this.los);
      return;
    }
    if (nd && dd <= 1.4 && this.rng() < 0.2 + cov * 0.0035) {
      this.end('int', this.los, nd);
      return;
    }
    this.end('incomplete', this.los);
  }

  private checkCarrier(): void {
    const c = this.carrier();
    if (!c) return;
    if (c.y >= 100) return this.end('td', c.y);
    if (c.x < 0 || c.x > FIELD_W) return this.end('oob', c.y);
    if (c.y <= 0 && c.side === 'off') return this.end('safety', c.y);
    for (const d of this.def) {
      if (d.stun > 0 || d.tackleCd > 0 || d.engaged || d.down > 0) continue;
      const reach = d.dive > 0 ? 1.6 : 1.15;
      const gap = dist(d, c);
      if (gap > reach) continue;
      const r = c.card.ratings;
      // Contact normal from tackler to runner, and how hard each body is moving into the other.
      const nx = (c.x - d.x) / (gap || 1);
      const ny = (c.y - d.y) / (gap || 1);
      const hitSpeed = Math.max(0.5, d.vx * nx + d.vy * ny);
      const runSpeed = Math.max(0, -(c.vx * nx + c.vy * ny)); // only a runner moving INTO the hit pushes back
      const hit = (d.mass * hitSpeed) / 800;
      const drive = (c.mass * runSpeed) / 800;
      const big = hit > 0.75;

      if (c.truck > 0) {
        // Truck: momentum and strength against the tackler's momentum and technique.
        const power = drive * (0.7 + r.str * 0.006) + 0.15;
        const resist = hit * (0.6 + d.card.ratings.tak * 0.005) + 0.12;
        const pWin = clamp(0.5 + (power - resist) * 1.4, 0.08, 0.9);
        if (this.rng() < pWin) {
          const fwd = this.heading(c);
          this.knockDown(d, fwd, 1.4);
          d.vx = fwd.x * (2 + drive * 4);
          d.vy = fwd.y * (2 + drive * 4);
          d.tackleCd = 2;
          // The runner pays for it in speed, more against a heavier man.
          const keep = 1 - 0.45 * (d.mass / (d.mass + c.mass));
          c.vx *= keep;
          c.vy *= keep;
          c.stumble = 0.35;
          c.truck = 0;
          this.float('TRUCKED!', d);
          continue;
        }
        return this.tackle(c, d, big);
      }

      let p = 0.66 + (d.card.ratings.tak - (r.car * 0.6 + r.str * 0.4)) * 0.011 + (hit - drive * 0.7) * 0.22;
      if (c.jukeT >= 0 || (c.evade > 0 && c.spinT < 0)) p *= 1 - r.agi * 0.0055;
      if (c.spinT >= 0) p *= 1 - r.agi * 0.0062;
      if (d.dive > 0) p += 0.12;
      if (c.slot === 'QB' && c.y <= this.los && !this.thrown) p += 0.15; // sacks are easier
      p = clamp(p, 0.06, 0.97);
      if (this.rng() < p) return this.tackle(c, d, big);

      // Broken tackle. What happens to the defender depends on how he was beaten.
      d.tackleCd = 1.2;
      if (c.spinT >= 0) {
        // Spun off: the defender is thrown past the runner's shoulder.
        const tx = -ny * c.spinDir;
        const ty = nx * c.spinDir;
        d.vx = tx * 3 + d.vx * 0.3;
        d.vy = ty * 3 + d.vy * 0.3;
        d.stumble = 0.6;
        d.stun = 0.5;
        this.float('SPUN OFF', d);
      } else if (c.evade > 0) {
        // Whiffed on a juke: he lunges at air and goes down.
        this.knockDown(d, { x: d.vx || -nx, y: d.vy || -ny }, 0.6);
        this.float('MISSED!', d);
      } else {
        // Bounced off: equal and opposite, weighted by mass.
        d.stun = 0.55;
        d.vx = -nx * 1.5;
        d.vy = -ny * 1.5;
        c.stumble = 0.4;
        const keep = 1 - 0.3 * (d.mass / (d.mass + c.mass));
        c.vx *= keep;
        c.vy *= keep;
        this.float('BROKEN TACKLE', c);
      }
    }
  }

  /** Bring the runner down. Both bodies fall along their combined momentum, so arm tackles from behind fall forward and big hits drive the runner back. */
  private tackle(c: Actor, d: Actor, big: boolean): void {
    const m = c.mass + d.mass;
    const px = (c.mass * c.vx + d.mass * d.vx) / m;
    const py = (c.mass * c.vy + d.mass * d.vy) / m;
    const fall = { x: px || 0.001, y: py };
    c.vx = px;
    c.vy = py;
    d.vx = px;
    d.vy = py;
    this.knockDown(c, fall, 1.5);
    this.knockDown(d, fall, 1.5);
    if (big) this.float('BIG HIT!', c);
    // Forward progress: where the pile lands, not where contact started.
    const endY = c.y + clamp(py * 0.3, -1.5, 1.8);
    const r = c.card.ratings;
    const sack = c.slot === 'QB' && this.offPlay.type === 'pass' && !this.thrown && c.y < this.los;
    const fumbleOdds = Math.max(0.006, (65 - r.car) * 0.0012) * (big ? 2 : 1);
    if (this.rng() < fumbleOdds && this.rng() < 0.55) return this.end('fumble', endY, d);
    this.end(sack ? 'sack' : 'tackle', endY, d);
  }

  private end(kind: OutcomeKind, y: number, by?: Actor): void {
    const endY = clamp(y, -10, 110);
    const yards = kind === 'incomplete' || kind === 'int' ? 0 : Math.round(Math.min(100, endY) - this.los);
    const c = this.carrier();
    const name = (a?: Actor | null) => (a ? `${a.card.first[0]}. ${a.card.last}` : '');
    let text = '';
    switch (kind) {
      case 'td': text = `TOUCHDOWN! ${name(c)}`; break;
      case 'tackle': text = `${yards >= 0 ? '+' : ''}${yards} yds — ${name(c)}`; break;
      case 'oob': text = `Out of bounds, ${yards >= 0 ? '+' : ''}${yards} yds`; break;
      case 'sack': text = `SACKED by ${name(by)} (${yards} yds)`; break;
      case 'incomplete': text = 'Incomplete'; break;
      case 'int': text = `INTERCEPTED by ${name(by)}!`; break;
      case 'fumble': text = `FUMBLE! Recovered by ${name(by)}`; break;
      case 'safety': text = 'SAFETY!'; break;
    }
    this.outcome = { kind, endY, yards, text };
    this.over = true;
    const at = this.ballPos();
    this.ball = { state: 'dead', at: { x: at.x, y: at.y } };
  }
}

// ---------------------------------------------------------------- kicking

export function fieldGoalRange(kicker: PlayerCard): number {
  return Math.round(42 + kicker.ratings.kpw * 0.15);
}

/** Kick distance is the ball's yard line to the goal post: yards to goal + 17. */
export function kickDistance(los: number): number {
  return Math.round(100 - los + 17);
}

export function fieldGoalChance(kicker: PlayerCard, distance: number): number {
  if (distance > fieldGoalRange(kicker)) return 0;
  const r = kicker.ratings;
  return clamp(0.99 - Math.max(0, distance - 22) * (0.011 + (100 - r.kpw) * 0.0003) - (100 - r.kac) * 0.0025, 0.05, 0.99);
}
