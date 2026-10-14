// How hard the game is. For now it only decides how well the police shoot: the chance
// of a hit is multiplied by `aim`. Remembered between visits.

export type Level = 'easy' | 'normal' | 'hard';
export const LEVELS: Level[] = ['easy', 'normal', 'hard'];

const AIM: Record<Level, number> = { easy: 0.45, normal: 1, hard: 1.35 };

let level: Level = 'normal';
try {
  const s = localStorage.getItem('difficulty');
  if (s === 'easy' || s === 'normal' || s === 'hard') level = s;
} catch { /* no storage: stay on normal */ }

export const difficulty = () => level;
export const aim = () => AIM[level];
export function setDifficulty(l: Level) {
  level = l;
  try { localStorage.setItem('difficulty', l); } catch { /* not remembered */ }
}

// Whether a car can hit anyone on foot. With "safe" on, pedestrians always get out of the
// way (they run off, or leap aside at the last moment), so driving never hurts anybody.
// Remembered between visits.
export type Walkers = 'hit' | 'safe';
export const WALKERS: Walkers[] = ['hit', 'safe'];

let walkers: Walkers = 'hit';
try {
  if (localStorage.getItem('walkers') === 'safe') walkers = 'safe';
} catch { /* no storage: pedestrians can be hit */ }

export const pedestrians = () => walkers;
export const safeRoads = () => walkers === 'safe';
export function setPedestrians(w: Walkers) {
  walkers = w;
  try { localStorage.setItem('walkers', w); } catch { /* not remembered */ }
}
