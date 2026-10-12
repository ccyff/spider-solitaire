/**
 * 蜘蛛纸牌 —— 模拟层类型定义。
 * 这一层不依赖 Phaser / DOM，是游戏规则的唯一真实来源（source of truth）。
 */

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export type SuitCount = 1 | 2 | 4;

export interface Card {
  /** 全局唯一 id，视图层用它建立「卡牌 -> 精灵」映射 */
  id: number;
  suit: Suit;
  rank: Rank;
  faceUp: boolean;
}

export interface GameState {
  version: 1;
  suitCount: SuitCount;
  seed: number;
  /** 10 个牌列，index 0 是第 1 列 */
  columns: Card[][];
  /** 待发的牌堆，每组 10 张，stock[0] 是下一组 */
  stock: Card[][];
  /** 已完成的同花顺（K→A），长度 0..8 */
  sets: Suit[];
  score: number;
  moves: number;
  elapsedMs: number;
  status: 'playing' | 'won';
}

export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'] as const;
/** 牌桌列数：手机上一屏能看清 5 列（列少 → 牌大 → 好认好点） */
export const COLUMN_COUNT = 5;
/** 一副牌 52 张 = 4 组同花 K→A */
export const TOTAL_SETS = 4;
export const START_SCORE = 500;

export const SUIT_LABEL: Record<Suit, string> = {
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
};

export const SUIT_NAME_ZH: Record<Suit, string> = {
  S: '黑桃',
  H: '红桃',
  D: '方块',
  C: '梅花',
};

export function isRedSuit(suit: Suit): boolean {
  return suit === 'H' || suit === 'D';
}

export function rankLabel(rank: Rank): string {
  switch (rank) {
    case 1:
      return 'A';
    case 11:
      return 'J';
    case 12:
      return 'Q';
    case 13:
      return 'K';
    default:
      return String(rank);
  }
}

export const DIFFICULTY_LABEL: Record<SuitCount, string> = {
  1: '1 花色 · 简单',
  2: '2 花色 · 中等',
  4: '4 花色 · 困难',
};
