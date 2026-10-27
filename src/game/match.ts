import { Roster } from '../data/lineup';
import { Rng } from '../data/rng';
import { Goal, Scenario, GAME_POSSESSIONS } from '../data/events';
import { PlayOutcome, Side, fieldGoalChance, kickDistance, fieldGoalRange } from './engine';
import { cpuOffensePlay } from './plays';

/**
 * Drive/match bookkeeping, independent of rendering. Ball position (`los`) is always measured
 * from the offense's own goal line, matching the engine's coordinate system.
 */
export interface Drive {
  side: Side; // which side the USER is playing this drive
  los: number;
  down: number;
  toGo: number;
  playsRun: number;
  playLimit: number | null;
  over: boolean;
  result: DriveResult | null;
  firstDowns: number;
}

export type DriveResult = 'td' | 'fg' | 'missed-fg' | 'turnover' | 'downs' | 'punt' | 'safety' | 'out-of-plays' | 'first-down';

export interface MatchConfig {
  kind: 'event' | 'season';
  userRoster: Roster;
  cpuRoster: Roster;
  cpuName: string;
  scenario?: Scenario;
}

export interface PlayReport {
  text: string;
  driveOver: boolean;
  scoreChange: { user: number; cpu: number };
}

export class Match {
  userScore = 0;
  cpuScore = 0;
  drive: Drive;
  possessions: Side[];
  possessionIdx = 0;
  over = false;
  log: string[] = [];
  userTouchdowns = 0;
  overtimeNote = '';

  constructor(readonly config: MatchConfig, private rng: Rng) {
    if (config.kind === 'event') {
      const s = config.scenario!;
      this.possessions = [s.side === 'offense' ? 'off' : 'def'];
      this.drive = this.newDrive(this.possessions[0], s.startYard, s.down, s.toGo, s.plays);
    } else {
      this.possessions = [];
      for (let i = 0; i < GAME_POSSESSIONS.offense + GAME_POSSESSIONS.defense; i++) this.possessions.push(i % 2 === 0 ? 'off' : 'def');
      this.drive = this.newDrive('off', 25, 1, 10, null);
    }
  }

  private newDrive(side: Side, los: number, down = 1, toGo = 10, playLimit: number | null = null): Drive {
    return { side, los, down, toGo, playsRun: 0, playLimit, over: false, result: null, firstDowns: 0 };
  }

  get offenseRoster(): Roster {
    return this.drive.side === 'off' ? this.config.userRoster : this.config.cpuRoster;
  }

  get defenseRoster(): Roster {
    return this.drive.side === 'off' ? this.config.cpuRoster : this.config.userRoster;
  }

  /** Goal-to-go situations: distance can't exceed the yards remaining. */
  get toGoLabel(): string {
    const d = this.drive;
    return d.los + d.toGo >= 100 ? 'Goal' : String(d.toGo);
  }

  get playsLeft(): number | null {
    const d = this.drive;
    return d.playLimit === null ? null : d.playLimit - d.playsRun;
  }

  fgDistance(): number {
    return kickDistance(this.drive.los);
  }

  canKickFg(): boolean {
    const k = this.offenseRoster.K;
    return this.fgDistance() <= fieldGoalRange(k);
  }

  /** Apply a finished play to the drive. */
  applyPlay(o: PlayOutcome): PlayReport {
    const d = this.drive;
    d.playsRun++;
    const change = { user: 0, cpu: 0 };
    const userOff = d.side === 'off';
    const score = (pts: number, offenseScored: boolean) => {
      if (offenseScored === userOff) { this.userScore += pts; change.user += pts; } else { this.cpuScore += pts; change.cpu += pts; }
    };
    let text = o.text;
    switch (o.kind) {
      case 'td':
        score(7, true);
        if (userOff) this.userTouchdowns++;
        this.endDrive('td');
        break;
      case 'safety':
        score(2, false);
        this.endDrive('safety');
        break;
      case 'int':
      case 'fumble':
        this.endDrive('turnover');
        break;
      default: {
        const gained = o.kind === 'incomplete' ? 0 : Math.round(o.endY) - d.los;
        d.los = Math.max(1, Math.min(99, d.los + gained));
        if (gained >= d.toGo) {
          d.down = 1;
          d.toGo = Math.min(10, 100 - d.los);
          d.firstDowns++;
          text += ' — FIRST DOWN';
          if (this.config.scenario?.goal === 'first-down' && userOff) {
            this.endDrive('first-down');
            break;
          }
        } else {
          d.down++;
          d.toGo -= gained;
          if (d.down > 4) {
            text += ' — Turnover on downs';
            this.endDrive('downs');
            break;
          }
        }
        if (d.playLimit !== null && d.playsRun >= d.playLimit) this.endDrive('out-of-plays');
      }
    }
    this.log.push(text);
    return { text, driveOver: d.over, scoreChange: change };
  }

  kickFieldGoal(): PlayReport {
    const d = this.drive;
    const dist = this.fgDistance();
    const made = this.rng() < fieldGoalChance(this.offenseRoster.K, dist);
    const change = { user: 0, cpu: 0 };
    d.playsRun++;
    if (made) {
      if (d.side === 'off') { this.userScore += 3; change.user = 3; } else { this.cpuScore += 3; change.cpu = 3; }
    }
    this.endDrive(made ? 'fg' : 'missed-fg');
    const text = `${dist}-yard field goal is ${made ? 'GOOD!' : 'NO GOOD'}`;
    this.log.push(text);
    return { text, driveOver: true, scoreChange: change };
  }

  punt(): PlayReport {
    this.drive.playsRun++;
    this.endDrive('punt');
    const text = 'Punt';
    this.log.push(text);
    return { text, driveOver: true, scoreChange: { user: 0, cpu: 0 } };
  }

  /** CPU 4th-down / last-play decision when the CPU has the ball. */
  cpuSpecialTeams(): 'go' | 'fg' | 'punt' {
    const d = this.drive;
    const lastPlay = this.playsLeft === 1;
    if (d.down < 4 && !lastPlay) return 'go';
    if (this.canKickFg() && fieldGoalChance(this.offenseRoster.K, this.fgDistance()) > 0.35) return 'fg';
    if (lastPlay) return 'go';
    if (d.toGo <= 2 && d.los >= 45) return 'go';
    return this.config.kind === 'event' ? 'go' : 'punt';
  }

  cpuOffensePlay() {
    const d = this.drive;
    return cpuOffensePlay(this.rng, d.down, d.toGo, 100 - d.los);
  }

  private endDrive(result: DriveResult): void {
    this.drive.over = true;
    this.drive.result = result;
  }

  /** Did the user achieve the event objective? Only meaningful once the drive is over. */
  eventWon(): boolean {
    const s = this.config.scenario;
    if (!s) return false;
    const r = this.drive.result;
    const goal: Goal = s.goal;
    if (goal === 'td') return r === 'td';
    if (goal === 'score') return r === 'td' || r === 'fg';
    if (goal === 'first-down') return r === 'first-down' || r === 'td';
    // 'stop': the CPU offense must not score.
    return r !== 'td' && r !== 'fg';
  }

  /** Move to the next possession in a season game. Returns false when the game is over. */
  nextPossession(): boolean {
    if (this.config.kind === 'event') {
      this.over = true;
      return false;
    }
    this.possessionIdx++;
    if (this.possessionIdx >= this.possessions.length) {
      if (this.userScore === this.cpuScore) this.resolveOvertime();
      this.over = true;
      return false;
    }
    const side = this.possessions[this.possessionIdx];
    // Field position after a score/kickoff is the 25; after a punt or turnover it varies a bit.
    const prev = this.drive.result;
    let start = 25;
    if (prev === 'turnover' || prev === 'downs') start = Math.max(10, Math.min(70, 100 - this.drive.los));
    else if (prev === 'punt') start = Math.max(8, Math.min(35, 100 - Math.min(99, this.drive.los + 40)));
    this.drive = this.newDrive(side, start);
    return true;
  }

  private resolveOvertime(): void {
    const userOvr = avgOvr(this.config.userRoster);
    const cpuOvr = avgOvr(this.config.cpuRoster);
    const pWin = Math.max(0.15, Math.min(0.85, 0.5 + (userOvr - cpuOvr) * 0.02));
    if (this.rng() < pWin) {
      this.userScore += 3;
      this.overtimeNote = 'Won in overtime on a field goal';
    } else {
      this.cpuScore += 3;
      this.overtimeNote = 'Lost in overtime on a field goal';
    }
  }

  get possessionLabel(): string {
    if (this.config.kind === 'event') return this.config.scenario!.title;
    return `Possession ${this.possessionIdx + 1} of ${this.possessions.length}`;
  }
}

function avgOvr(r: Roster): number {
  const v = Object.values(r);
  return v.reduce((a, p) => a + p.ovr, 0) / v.length;
}

export function ordinal(n: number): string {
  return ['1st', '2nd', '3rd', '4th'][n - 1] ?? `${n}th`;
}

/** "OWN 35" / "OPP 20" / "50" from the user's perspective. */
export function spotLabel(los: number, userOffense: boolean): string {
  const y = Math.round(los);
  if (y === 50) return '50';
  const ownSide = y < 50;
  const n = ownSide ? y : 100 - y;
  // los is from the offense's perspective; flip ownership when the user is defending.
  return `${ownSide === userOffense ? 'OWN' : 'OPP'} ${n}`;
}
