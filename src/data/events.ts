/**
 * Live Events: short, replayable scenarios in the style of 2015-era mobile football.
 * Each one drops you into a game situation with a single objective.
 */
export type Goal = 'td' | 'score' | 'first-down' | 'stop';

export interface Scenario {
  id: string;
  title: string;
  desc: string;
  side: 'offense' | 'defense';
  /** Yards from the user's own goal line where the ball starts (offense), or from the CPU's own goal (defense). */
  startYard: number;
  down: number;
  toGo: number;
  /** Max plays the user gets (offense) or the CPU gets (defense). */
  plays: number;
  goal: Goal;
  opponentOvr: number;
  stamina: number;
  coins: number;
  xp: number;
  minLevel: number;
}

export const LIVE_EVENTS: Scenario[] = [
  {
    id: 'two-minute', title: 'Two-Minute Drill', side: 'offense',
    desc: 'Trailing by 4, ball on your own 35. You have 8 plays to find the end zone.',
    startYard: 35, down: 1, toGo: 10, plays: 8, goal: 'td', opponentOvr: 58,
    stamina: 5, coins: 400, xp: 60, minLevel: 1,
  },
  {
    id: 'goal-line', title: 'Goal Line Stand', side: 'defense',
    desc: 'They have 1st & goal at your 5. Hold them out for 4 plays.',
    startYard: 95, down: 1, toGo: 5, plays: 4, goal: 'stop', opponentOvr: 58,
    stamina: 5, coins: 400, xp: 60, minLevel: 1,
  },
  {
    id: 'move-chains', title: 'Move the Chains', side: 'offense',
    desc: '3rd & 7 from midfield. Convert the first down.',
    startYard: 50, down: 3, toGo: 7, plays: 1, goal: 'first-down', opponentOvr: 62,
    stamina: 3, coins: 250, xp: 40, minLevel: 1,
  },
  {
    id: 'red-zone', title: 'Red Zone Rush', side: 'offense',
    desc: '1st & 10 at their 18. Punch it in within 4 plays.',
    startYard: 82, down: 1, toGo: 10, plays: 4, goal: 'td', opponentOvr: 66,
    stamina: 5, coins: 600, xp: 80, minLevel: 2,
  },
  {
    id: 'shut-down', title: 'Shut Down Corner', side: 'defense',
    desc: 'Their offense is rolling at midfield. Keep them off the board — 6 plays.',
    startYard: 50, down: 1, toGo: 10, plays: 6, goal: 'stop', opponentOvr: 68,
    stamina: 6, coins: 700, xp: 90, minLevel: 3,
  },
  {
    id: 'long-haul', title: 'The Long Haul', side: 'offense',
    desc: 'Backed up at your own 10. Go 90 yards in 10 plays.',
    startYard: 10, down: 1, toGo: 10, plays: 10, goal: 'td', opponentOvr: 72,
    stamina: 8, coins: 1200, xp: 140, minLevel: 4,
  },
  {
    id: 'walk-off', title: 'Walk-Off Field Goal', side: 'offense',
    desc: 'Tie game, ball at your 40. Get into range and score in 5 plays.',
    startYard: 40, down: 1, toGo: 10, plays: 5, goal: 'score', opponentOvr: 76,
    stamina: 6, coins: 1500, xp: 160, minLevel: 5,
  },
  {
    id: 'elite-test', title: 'Elite Gauntlet', side: 'defense',
    desc: 'An elite offense, 1st & 10 at your 30. Do not let them score in 6 plays.',
    startYard: 70, down: 1, toGo: 10, plays: 6, goal: 'stop', opponentOvr: 84,
    stamina: 10, coins: 3500, xp: 300, minLevel: 7,
  },
];

export interface SeasonWeek {
  week: number;
  opponent: string;
  opponentOvr: number;
}

export const SEASON_LENGTH = 12;

export function seasonSchedule(seasonNumber: number, teams: readonly string[]): SeasonWeek[] {
  const weeks: SeasonWeek[] = [];
  const base = 54 + Math.min(20, (seasonNumber - 1) * 5);
  for (let i = 0; i < SEASON_LENGTH; i++) {
    weeks.push({
      week: i + 1,
      opponent: teams[(i + seasonNumber * 3) % teams.length],
      opponentOvr: Math.min(95, base + Math.round(i * 2.2)),
    });
  }
  return weeks;
}

/** Possessions each side gets in a season game (alternating, offense first). */
export const GAME_POSSESSIONS = { offense: 3, defense: 3 };

export function xpForLevel(level: number): number {
  return 150 + (level - 1) * 125;
}
