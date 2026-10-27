import { Slot } from '../data/lineup';

export type Pt = [number, number];
export type Receiver = 'WR1' | 'WR2' | 'WR3' | 'TE' | 'HB';

export interface OffPlay {
  id: string;
  name: string;
  type: 'run' | 'pass';
  desc: string;
  /** Run plays: lateral offset (yards) of the hole from the center. */
  hole?: number;
  /** Pass plays: route waypoints relative to each receiver's alignment (dx right, dy downfield). */
  routes?: Partial<Record<Receiver, Pt[]>>;
  playAction?: boolean;
}

export type DefAssign =
  | { kind: 'rush' }
  | { kind: 'man'; target: Receiver }
  | { kind: 'zone'; x: number; y: number }
  | { kind: 'spy' };

export interface DefPlay {
  id: string;
  name: string;
  desc: string;
  assign: Partial<Record<Slot, DefAssign>>;
}

export const OFFENSE_PLAYBOOK: OffPlay[] = [
  { id: 'dive', name: 'HB Dive', type: 'run', hole: 0, desc: 'Quick hit up the middle.' },
  { id: 'off-tackle', name: 'HB Off Tackle', type: 'run', hole: 5, desc: 'Run behind the right tackle.' },
  { id: 'toss', name: 'HB Toss', type: 'run', hole: -9, desc: 'Pitch it wide to the left edge.' },
  {
    id: 'slants', name: 'Slants', type: 'pass', desc: 'Quick inside breaks. Beats zone underneath.',
    routes: {
      WR1: [[0, 3], [6, 7], [14, 11]],
      WR2: [[0, 3], [-6, 7], [-14, 11]],
      WR3: [[0, 6], [-5, 12], [-8, 22]],
      TE: [[0, 4], [-8, 6], [-18, 7]],
      HB: [[-4, 1], [-9, 3]],
    },
  },
  {
    id: 'curls', name: 'Curls', type: 'pass', desc: 'Receivers sit down at 10 yards.',
    routes: {
      WR1: [[0, 12], [1, 10]],
      WR2: [[0, 12], [-1, 10]],
      WR3: [[0, 6], [6, 7]],
      TE: [[0, 9], [-1, 7]],
      HB: [[5, 1], [10, 3]],
    },
  },
  {
    id: 'verts', name: 'Four Verticals', type: 'pass', desc: 'Everyone goes deep. Beat man coverage.',
    routes: {
      WR1: [[0, 45]],
      WR2: [[0, 45]],
      WR3: [[-2, 8], [-2, 45]],
      TE: [[-4, 10], [-6, 45]],
      HB: [[3, 3], [4, 4]],
    },
  },
  {
    id: 'pa-post', name: 'PA Deep Post', type: 'pass', playAction: true, desc: 'Fake the run, hit the post over the top.',
    routes: {
      WR1: [[0, 12], [9, 32]],
      WR2: [[0, 12], [-1, 10]],
      WR3: [[0, 8], [8, 18]],
      TE: [[0, 2], [6, 5]],
    },
  },
  {
    id: 'outs', name: 'Outs & Drag', type: 'pass', desc: 'Sideline outs with a crossing drag.',
    routes: {
      WR1: [[0, 8], [-7, 8]],
      WR2: [[0, 8], [7, 8]],
      WR3: [[-2, 3], [-18, 5]],
      TE: [[0, 14], [6, 22]],
      HB: [[-5, 2], [-6, 3]],
    },
  },
];

const RUSH4: Partial<Record<Slot, DefAssign>> = {
  LE: { kind: 'rush' }, DT1: { kind: 'rush' }, DT2: { kind: 'rush' }, RE: { kind: 'rush' },
};

export const DEFENSE_PLAYBOOK: DefPlay[] = [
  {
    id: 'cover2', name: 'Cover 2 Zone', desc: 'Two deep safeties, corners sit in the flats.',
    assign: {
      ...RUSH4,
      LOLB: { kind: 'zone', x: -9, y: 7 }, MLB: { kind: 'zone', x: 0, y: 9 }, ROLB: { kind: 'zone', x: 9, y: 7 },
      CB1: { kind: 'zone', x: -18, y: 5 }, CB2: { kind: 'zone', x: 18, y: 5 },
      FS: { kind: 'zone', x: -11, y: 20 }, SS: { kind: 'zone', x: 11, y: 20 },
    },
  },
  {
    id: 'cover3', name: 'Cover 3 Zone', desc: 'Three deep, four underneath. Safe vs deep balls.',
    assign: {
      ...RUSH4,
      LOLB: { kind: 'zone', x: -14, y: 6 }, MLB: { kind: 'zone', x: -4, y: 8 }, ROLB: { kind: 'zone', x: 5, y: 8 },
      SS: { kind: 'zone', x: 15, y: 6 },
      CB1: { kind: 'zone', x: -18, y: 18 }, CB2: { kind: 'zone', x: 18, y: 18 }, FS: { kind: 'zone', x: 0, y: 22 },
    },
  },
  {
    id: 'cover1', name: 'Man Press', desc: 'Man-to-man with a deep safety and a QB spy.',
    assign: {
      ...RUSH4,
      CB1: { kind: 'man', target: 'WR1' }, CB2: { kind: 'man', target: 'WR2' },
      SS: { kind: 'man', target: 'WR3' }, ROLB: { kind: 'man', target: 'TE' }, LOLB: { kind: 'man', target: 'HB' },
      MLB: { kind: 'spy' }, FS: { kind: 'zone', x: 0, y: 20 },
    },
  },
  {
    id: 'blitz', name: 'Inside Blitz', desc: 'Send six. Get home fast or get burned.',
    assign: {
      ...RUSH4,
      LOLB: { kind: 'rush' }, MLB: { kind: 'rush' },
      CB1: { kind: 'man', target: 'WR1' }, CB2: { kind: 'man', target: 'WR2' },
      FS: { kind: 'man', target: 'WR3' }, SS: { kind: 'man', target: 'TE' }, ROLB: { kind: 'man', target: 'HB' },
    },
  },
  {
    id: 'runstop', name: 'Run Stop', desc: 'Load the box and fill gaps. Weak vs the slot.',
    assign: {
      ...RUSH4,
      MLB: { kind: 'rush' }, LOLB: { kind: 'zone', x: -5, y: 3 }, ROLB: { kind: 'zone', x: 5, y: 3 },
      CB1: { kind: 'man', target: 'WR1' }, CB2: { kind: 'man', target: 'WR2' },
      SS: { kind: 'man', target: 'TE' }, FS: { kind: 'zone', x: 0, y: 15 },
    },
  },
];

/** Alignment offsets (dx from ball, dy from line of scrimmage) for every slot. */
export const OFF_ALIGN: Partial<Record<Slot, Pt>> = {
  QB: [0, -4], HB: [0, -7.5],
  WR1: [-20, -1], WR2: [20, -1], WR3: [12, -1.5], TE: [6.5, -1],
  LT: [-4.4, -1], LG: [-2.2, -1], C: [0, -1], RG: [2.2, -1], RT: [4.4, -1],
};

export const DEF_ALIGN: Partial<Record<Slot, Pt>> = {
  LE: [-5.5, 1], DT1: [-1.8, 1], DT2: [1.8, 1], RE: [5.5, 1],
  LOLB: [-6, 5], MLB: [0, 5.5], ROLB: [6, 5],
  CB1: [-20, 6], CB2: [20, 6], FS: [-8, 14], SS: [8, 12],
};

export function cpuOffensePlay(rng: () => number, down: number, toGo: number, yardsToGoal: number): OffPlay {
  let pRun = down === 1 ? 0.5 : toGo <= 3 ? 0.6 : toGo >= 8 ? 0.2 : 0.4;
  if (yardsToGoal <= 5) pRun = 0.55;
  const type = rng() < pRun ? 'run' : 'pass';
  const options = OFFENSE_PLAYBOOK.filter((p) => p.type === type && !(yardsToGoal < 15 && p.id === 'verts'));
  return options[Math.floor(rng() * options.length)];
}

export function cpuDefensePlay(rng: () => number, down: number, toGo: number): DefPlay {
  const byId = (id: string) => DEFENSE_PLAYBOOK.find((p) => p.id === id)!;
  const r = rng();
  if (toGo <= 3) return byId(r < 0.45 ? 'runstop' : r < 0.7 ? 'blitz' : 'cover1');
  if (toGo >= 8 && down >= 2) return byId(r < 0.4 ? 'cover3' : r < 0.75 ? 'cover2' : r < 0.9 ? 'cover1' : 'blitz');
  return DEFENSE_PLAYBOOK[Math.floor(r * DEFENSE_PLAYBOOK.length)];
}
