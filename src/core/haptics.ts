/**
 * 手机上的轻震动反馈。
 * Android Chrome / 部分国产浏览器支持 navigator.vibrate；iOS Safari 不支持，
 * 所以这里静默降级，不影响任何逻辑。
 */

let enabled = true;

export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

export type HapticKind = 'tap' | 'invalid' | 'drop' | 'complete' | 'win';

const PATTERNS: Record<HapticKind, number | number[]> = {
  tap: 8,
  invalid: 24,
  drop: 10,
  complete: [12, 40, 22],
  win: [16, 60, 16, 60, 32],
};

export function haptic(kind: HapticKind): void {
  if (!enabled) return;
  const nav = navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(PATTERNS[kind]);
  } catch {
    /* 某些浏览器在无用户手势时会抛错，忽略即可 */
  }
}
