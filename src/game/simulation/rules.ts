import { TOTAL_SETS, type Card, type GameState, type Suit } from './types';

export type MoveRejection =
  | 'same-column'
  | 'not-pickable'
  | 'bad-target'
  | 'no-stock'
  | 'empty-column';

/** 该列最上面一张牌 */
export function topCard(column: Card[]): Card | undefined {
  return column.length > 0 ? column[column.length - 1] : undefined;
}

/** from 起（含）到列底，是否是同一花色、点数连续递减的明牌序列 */
export function isMovableRun(cards: Card[]): boolean {
  if (cards.length === 0) return false;
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    if (!card.faceUp) return false;
    if (i > 0) {
      const prev = cards[i - 1];
      if (card.suit !== prev.suit) return false;
      if (card.rank !== prev.rank - 1) return false;
    }
  }
  return true;
}

/** 能否把 column[index..] 整段拿起 */
export function canPickUp(state: GameState, column: number, index: number): boolean {
  const col = state.columns[column];
  if (!col || index < 0 || index >= col.length) return false;
  return isMovableRun(col.slice(index));
}

/**
 * 能否落在目标列上：空列可放任意牌；否则必须比目标顶牌小 1 点（不限花色）。
 */
export function canDropOn(column: Card[], moving: Card): boolean {
  const top = topCard(column);
  if (!top) return true;
  if (!top.faceUp) return false;
  return top.rank === moving.rank + 1;
}

/** 列尾是否凑齐同花 K→A，返回该花色 */
export function completedSuit(column: Card[]): Suit | null {
  if (column.length < 13) return null;
  const run = column.slice(column.length - 13);
  for (let i = 0; i < run.length; i += 1) {
    const card = run[i];
    if (!card.faceUp) return null;
    if (card.rank !== 13 - i) return null;
    if (card.suit !== run[0].suit) return null;
  }
  return run[0].suit;
}

/** 经典规则：牌堆非空，且没有任何空列 */
export function dealBlockReason(state: GameState): MoveRejection | null {
  if (state.stock.length === 0) return 'no-stock';
  if (state.columns.some((col) => col.length === 0)) return 'empty-column';
  return null;
}

export function isWon(state: GameState): boolean {
  return state.sets.length >= TOTAL_SETS;
}

/** 全局是否还有任何合法移动（用于「无路可走」提示） */
export function hasAnyMove(state: GameState): boolean {
  for (let from = 0; from < state.columns.length; from += 1) {
    const col = state.columns[from];
    for (let idx = 0; idx < col.length; idx += 1) {
      if (!canPickUp(state, from, idx)) continue;
      const moving = col[idx];
      for (let to = 0; to < state.columns.length; to += 1) {
        if (to === from) continue;
        if (canDropOn(state.columns[to], moving)) return true;
      }
    }
  }
  return false;
}
