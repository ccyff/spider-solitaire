import { mulberry32, shuffle } from './rng';
import type { Card, Rank, Suit, SuitCount } from './types';
import { COLUMN_COUNT } from './types';

/** 按难度决定 8 副 A→K 里各花色的数量：1 花色 = 8×黑桃，2 花色 = 4+4，4 花色 = 2+2+2+2 */
function suitPlan(suitCount: SuitCount): Suit[] {
  switch (suitCount) {
    case 1:
      return ['S', 'S', 'S', 'S', 'S', 'S', 'S', 'S'];
    case 2:
      return ['S', 'S', 'S', 'S', 'H', 'H', 'H', 'H'];
    default:
      return ['S', 'S', 'H', 'H', 'D', 'D', 'C', 'C'];
  }
}

/** 生成 104 张牌并洗匀（同一 seed 结果完全一致） */
export function buildShuffledDeck(suitCount: SuitCount, seed: number): Card[] {
  const rand = mulberry32(seed);
  const plan = suitPlan(suitCount);
  const deck: Card[] = [];
  let id = 0;
  for (const suit of plan) {
    for (let rank = 1 as number; rank <= 13; rank += 1) {
      deck.push({ id: id++, suit, rank: rank as Rank, faceUp: false });
    }
  }
  return shuffle(deck, rand);
}

/**
 * 发初始牌局：
 * 104 张里 54 张上桌（前 4 列 6 张，后 6 列 5 张），每列最后一张明牌；
 * 剩余 50 张分成 5 组，每组 10 张作为「发牌堆」。
 */
export function dealTableau(deck: Card[]): { columns: Card[][]; stock: Card[][] } {
  const columns: Card[][] = Array.from({ length: COLUMN_COUNT }, () => []);
  const pool = deck.slice();
  for (let col = 0; col < COLUMN_COUNT; col += 1) {
    const count = col < 4 ? 6 : 5;
    for (let i = 0; i < count; i += 1) {
      const card = pool.shift();
      if (!card) throw new Error('牌堆数量不足，无法发牌');
      columns[col].push(card);
    }
    const top = columns[col][columns[col].length - 1];
    top.faceUp = true;
  }
  const stock: Card[][] = [];
  while (pool.length > 0) {
    stock.push(pool.splice(0, COLUMN_COUNT));
  }
  return { columns, stock };
}
