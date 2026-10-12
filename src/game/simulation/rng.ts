/** 可复现的伪随机数（mulberry32），方便复盘、测试与「重开同一局」。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/** 原地 Fisher–Yates 洗牌 */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}
