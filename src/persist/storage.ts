import type { SuitCount } from '../game/simulation/types';

const SETTINGS_KEY = 'spider.settings.v1';
const GAME_KEY = 'spider.game.v1';
const BEST_KEY = 'spider.best.v1';
const FLAG_PREFIX = 'spider.flag.';

export interface Settings {
  sfx: boolean;
  music: boolean;
  haptics: boolean;
  suitCount: SuitCount;
}

const DEFAULT_SETTINGS: Settings = { sfx: true, music: true, haptics: true, suitCount: 1 };

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式或空间不足时静默忽略 */
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

export function loadSettings(): Settings {
  const raw = read(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const suitCount = parsed.suitCount === 1 || parsed.suitCount === 2 || parsed.suitCount === 4
      ? parsed.suitCount
      : DEFAULT_SETTINGS.suitCount;
    return {
      sfx: parsed.sfx !== false,
      music: parsed.music !== false,
      haptics: parsed.haptics !== false,
      suitCount,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS_KEY, JSON.stringify(settings));
}

export function saveGame(serialized: string): void {
  write(GAME_KEY, serialized);
}

export function loadGame(): string | null {
  return read(GAME_KEY);
}

export function clearGame(): void {
  remove(GAME_KEY);
}

type BestTable = Record<string, number>;

export function loadBest(): BestTable {
  const raw = read(BEST_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as BestTable;
  } catch {
    return {};
  }
}

export function bestFor(suitCount: SuitCount): number {
  const value = loadBest()[String(suitCount)];
  return typeof value === 'number' ? value : 0;
}

/** 记录最佳成绩，返回是否刷新了纪录 */
export function recordBest(suitCount: SuitCount, score: number): boolean {
  const table = loadBest();
  const key = String(suitCount);
  const previous = table[key] ?? 0;
  if (score <= previous) return false;
  table[key] = score;
  write(BEST_KEY, JSON.stringify(table));
  return true;
}

export function hasFlag(name: string): boolean {
  return read(FLAG_PREFIX + name) === '1';
}

export function setFlag(name: string): void {
  write(FLAG_PREFIX + name, '1');
}
