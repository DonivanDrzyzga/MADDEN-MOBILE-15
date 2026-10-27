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
  burst: Vec | null;
  burstT: number;
  dive: number;
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

const speedFor = (spd: number) => 2.2 + spd * 0.075;
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
  handedOff = false;
  sprintMeter = 1;
  floats: FloatText[] = [];
  readonly los: number;
  readonly offPlay: OffPlay;
  readonly defPlay: DefPlay;
  readonly userSide: Side;
  private rng: Rng;
  private qbReadAt: number;

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
      accel: 10 + card.ratings.agi * 0.06,
      route: null, routeIdx: 0, sit: false, blocker: false,
      assign: null, engaged: null, shedImmune: 0, stun: 0, tackleCd: 0, react: -1,
      evade: 0, truck: 0, moveCd: 0, burst: null, burstT: 0, dive: 0,
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
    for (const dfn of this.def) dfn.react = 0.12 + (100 - dfn.card.ratings.cov) * 0.006 + this.rng() * 0.15;
    if (this.userSide === 'off') this.controlled = target;
    return true;
  }

  private carrierCanMove(): Actor | null {
    const c = this.carrier();
    if (!c || this.over || c.moveCd > 0 || c.stun > 0) return null;
    if (c.slot === 'QB' && this.canThrow() && this.offPlay.type === 'pass') return null;
    return c;
  }

  juke(): void {
    const c = this.carrierCanMove();
    if (!c) return;
    const near = this.nearestDefender(c);
    const fwd = norm(c.vx, c.vy || 1);
    let side = { x: fwd.y, y: -fwd.x };
    if (near && (near.x - c.x) * side.x + (near.y - c.y) * side.y > 0) side = { x: -side.x, y: -side.y };
    c.burst = { x: side.x * c.speed * 1.05 + fwd.x * 2, y: side.y * c.speed * 1.05 + fwd.y * 2 };
    c.burstT = 0.24;
    c.evade = 0.25 + c.card.ratings.agi * 0.003;
    c.moveCd = 1.0;
    this.float('JUKE', c);
  }

  spin(): void {
    const c = this.carrierCanMove();
    if (!c) return;
    const fwd = norm(c.vx, c.vy || 1);
    c.burst = { x: fwd.x * c.speed * 0.7, y: fwd.y * c.speed * 0.7 };
    c.burstT = 0.4;
    c.evade = 0.3 + c.card.ratings.agi * 0.003;
    c.moveCd = 1.3;
    this.float('SPIN', c);
  }

  truck(): void {
    const c = this.carrierCanMove();
    if (!c) return;
    c.truck = 0.55;
    c.moveCd = 1.1;
    this.float('TRUCK', c);
  }

  /** Defense: lunge at the ball carrier. */
  dive(): void {
    const me = this.controlled;
    const c = this.carrier() ?? (this.ball.state === 'air' ? this.ball.target : null);
    if (!me || me.side !== 'def' || this.over || me.stun > 0 || me.dive > 0 || me.engaged || !c) return;
    const dir = norm(c.x - me.x, c.y - me.y);
    me.burst = { x: dir.x * (me.speed + 3), y: dir.y * (me.speed + 3) };
    me.burstT = 0.35;
    me.dive = 0.45;
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
      a.dive = Math.max(0, a.dive - dt);
      if (a.react > 0) a.react = Math.max(0, a.react - dt);
    }

    this.updateBlocks(dt);

    for (const a of this.actors) {
      let desired: Vec;
      let maxSpeed = a.speed;
      const userHere = a === this.controlled && input.move && (a.side === this.userSide);
      if (a.burst && a.burstT > 0) {
        a.burstT -= dt;
        a.vx = a.burst.x;
        a.vy = a.burst.y;
        if (a.burstT <= 0) a.burst = null;
        continue;
      }
      if (a.stun > 0) {
        a.vx *= 0.85;
        a.vy *= 0.85;
        continue;
      }
      if (a.engaged) continue; // handled in updateBlocks
      if (userHere && !(a.slot === 'QB' && this.ball.state === 'air')) {
        desired = { x: input.move!.x, y: input.move!.y };
        if (a === carrier && sprinting) maxSpeed *= 1.12;
      } else {
        desired = this.ai(a);
      }
      if (a === carrier) maxSpeed *= 0.94; // carrying the ball costs a step
      else if (carrier && a.side !== carrier.side && a.y < carrier.y && dist(a, carrier) < 4) maxSpeed *= 1.07; // chase-down burst
      if (a.truck > 0) maxSpeed *= 0.9;
      if (a === carrier && a.evade > 0 && !a.burst) maxSpeed *= 0.85;
      const tvx = desired.x * maxSpeed;
      const tvy = desired.y * maxSpeed;
      const accel = (a === carrier && sprinting ? a.accel * 0.7 : a.accel) * dt;
      const dvx = tvx - a.vx;
      const dvy = tvy - a.vy;
      const dl = len(dvx, dvy);
      if (dl <= accel) { a.vx = tvx; a.vy = tvy; } else { a.vx += (dvx / dl) * accel; a.vy += (dvy / dl) * accel; }
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
      if (dd < bd && d.stun <= 0) { bd = dd; best = d; }
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
      if (d.stun > 0 || d.engaged) continue;
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
      if (d.engaged || d.shedImmune > 0 || d.stun > 0) continue;
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
      if (b.engaged || b.stun > 0 || b === carrier || b.slot === 'QB') continue;
      if (!b.blocker && !runPhase) continue;
      for (const d of this.def) {
        if (d.engaged || d.shedImmune > 0 || d.stun > 0 || d.dive > 0) continue;
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
      // Defender pushes toward the ball; the blocker gives ground slowly.
      const push = clamp((pass ? 0.45 : 0.8) + (defPow - blkPow) * 0.04, 0.1, 2.2);
      const dir = norm(protect.x - d.x, protect.y - d.y);
      d.vx = dir.x * push;
      d.vy = dir.y * push;
      b.vx = d.vx;
      b.vy = d.vy;
      // Keep the blocker squared up between the defender and the ball.
      const want = { x: d.x + dir.x * 1.0, y: d.y + dir.y * 1.0 };
      b.x += (want.x - b.x) * Math.min(1, dt * 8);
      b.y += (want.y - b.y) * Math.min(1, dt * 8);
    }
  }

  private separate(): void {
    const c = this.carrier();
    const n = this.actors.length;
    for (let i = 0; i < n; i++) {
      const a = this.actors[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.actors[j];
        if (a.engaged === b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a === c || b === c ? 0.7 : 0.85;
        if (d > 0 && d < min) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
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
      if (d.stun > 0 || d.tackleCd > 0 || d.engaged) continue;
      const reach = d.dive > 0 ? 1.6 : 1.15;
      if (dist(d, c) > reach) continue;
      const r = c.card.ratings;
      const breakSkill = c.truck > 0 ? r.str : r.car * 0.6 + r.str * 0.4;
      let p = 0.74 + (d.card.ratings.tak - breakSkill) * 0.011;
      if (c.truck > 0) p -= 0.05;
      if (c.evade > 0) p *= 1 - r.agi * 0.0055;
      if (d.dive > 0) p += 0.12;
      if (c.slot === 'QB' && c.y <= this.los && !this.thrown) p += 0.15; // sacks are easier
      p = clamp(p, 0.06, 0.97);
      if (this.rng() < p) {
        const passPlay = this.offPlay.type === 'pass';
        const sack = c.slot === 'QB' && passPlay && !this.thrown && c.y < this.los;
        if (this.rng() < Math.max(0.006, (65 - r.car) * 0.0012) && this.rng() < 0.55) {
          return this.end('fumble', c.y, d);
        }
        return this.end(sack ? 'sack' : 'tackle', c.y, d);
      }
      d.tackleCd = 1.2;
      d.stun = 0.6;
      if (c.truck > 0) {
        d.vx = 0; d.vy = 0;
        this.float('TRUCKED!', d);
      } else {
        this.float(c.evade > 0 ? 'MISSED!' : 'BROKEN TACKLE', c);
      }
    }
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
