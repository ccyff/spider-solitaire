import { mulberry32, shuffle } from './rng';
import type { Card, Rank, Suit, SuitCount } from './types';
import { COLUMN_COUNT } from './types';

/**
 * 一副牌 52 张 = 4 组 A→K。
 * 难度决定这 4 组用什么花色：1 花色 = 全是黑桃（最简单），2 花色 = 黑桃+红桃各 2 组，4 花色 = 四种各 1 组。
 */
function suitPlan(suitCount: SuitCount): Suit[] {
  switch (suitCount) {
    case 1:
      return ['S', 'S', 'S', 'S'];
    case 2:
      return ['S', 'S', 'H', 'H'];
    default:
      return ['S', 'H', 'D', 'C'];
  }
}

/** 生成 52 张牌并洗匀（同一 seed 结果完全一致） */
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
 * 52 张里 27 张上桌（6/6/5/5/5），每列最后一张明牌；
 * 剩余 25 张分成 5 组，每组 5 张作为「发牌堆」。
 */
const TABLEAU_SIZES = [6, 6, 5, 5, 5] as const;

export function dealTableau(deck: Card[]): { columns: Card[][]; stock: Card[][] } {
  const columns: Card[][] = Array.from({ length: COLUMN_COUNT }, () => []);
  const pool = deck.slice();
  for (let col = 0; col < COLUMN_COUNT; col += 1) {
    const count = TABLEAU_SIZES[col] ?? 5;
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
