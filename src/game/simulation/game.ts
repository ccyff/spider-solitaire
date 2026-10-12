import { buildShuffledDeck, dealTableau } from './deck';
import { randomSeed } from './rng';
import {
  canDropOn,
  canPickUp,
  completedSuit,
  dealBlockReason,
  hasAnyMove,
  isWon,
  topCard,
  type MoveRejection,
} from './rules';
import {
  COLUMN_COUNT,
  START_SCORE,
  TOTAL_SETS,
  type GameState,
  type Suit,
  type SuitCount,
} from './types';

export interface MoveOutcome {
  ok: boolean;
  reason?: MoveRejection;
  /** 实际落点列 */
  to?: number;
  /** 移动了几张牌 */
  count?: number;
  /** 翻开了新的明牌 */
  flipped?: boolean;
  /** 本次移动完成的同花顺 */
  completed?: Suit[];
  /** 被收走的牌 id，交给视图层做飞牌动画 */
  completedIds?: number[];
}

export interface HintMove {
  from: number;
  index: number;
  to: number;
  score: number;
}

export interface DealOutcome {
  ok: boolean;
  reason?: MoveRejection;
  completed?: Suit[];
  completedIds?: number[];
}

const MAX_HISTORY = 400;

/**
 * SpiderGame —— 蜘蛛纸牌的全部规则与状态。
 * 不引用任何渲染对象，可序列化、可撤销、可在 Node 里直接跑测试。
 */
export class SpiderGame {
  state: GameState;
  private history: string[] = [];

  private constructor(state: GameState) {
    this.state = state;
  }

  static newGame(suitCount: SuitCount = 1, seed: number = randomSeed()): SpiderGame {
    const deck = buildShuffledDeck(suitCount, seed);
    const { columns, stock } = dealTableau(deck);
    return new SpiderGame({
      version: 1,
      suitCount,
      seed,
      columns,
      stock,
      sets: [],
      score: START_SCORE,
      moves: 0,
      elapsedMs: 0,
      status: 'playing',
    });
  }

  static fromState(state: GameState): SpiderGame {
    const game = new SpiderGame(state);
    game.state.status = isWon(state) ? 'won' : 'playing';
    return game;
  }

  static deserialize(raw: string): SpiderGame | null {
    try {
      const parsed = JSON.parse(raw) as GameState;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.columns)) return null;
      if (parsed.columns.length !== COLUMN_COUNT) return null;
      return SpiderGame.fromState(parsed);
    } catch {
      return null;
    }
  }

  get isWon(): boolean {
    return this.state.status === 'won';
  }

  get completedSets(): number {
    return this.state.sets.length;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  get dealBlockReason(): MoveRejection | null {
    return dealBlockReason(this.state);
  }

  get hasMove(): boolean {
    return hasAnyMove(this.state);
  }

  /** 计时（由场景每帧驱动，覆盖层打开时可暂停） */
  tick(deltaMs: number): void {
    if (this.state.status !== 'playing') return;
    this.state.elapsedMs += deltaMs;
  }

  cardAt(column: number, index: number): GameState['columns'][number][number] | undefined {
    return this.state.columns[column]?.[index];
  }

  canMove(from: number, index: number, to: number): boolean {
    if (from === to) return false;
    if (!canPickUp(this.state, from, index)) return false;
    const moving = this.state.columns[from][index];
    return canDropOn(this.state.columns[to], moving);
  }

  /** 执行一次移动；失败时返回原因且不修改任何状态 */
  move(from: number, index: number, to: number): MoveOutcome {
    if (this.state.status === 'won') return { ok: false, reason: 'same-column' };
    if (from === to) return { ok: false, reason: 'same-column' };
    if (!canPickUp(this.state, from, index)) return { ok: false, reason: 'not-pickable' };
    const moving = this.state.columns[from][index];
    if (!canDropOn(this.state.columns[to], moving)) return { ok: false, reason: 'bad-target' };

    this.pushHistory();

    const source = this.state.columns[from];
    const chunk = source.splice(index);
    this.state.columns[to].push(...chunk);

    let flipped = false;
    const newTop = topCard(source);
    if (newTop && !newTop.faceUp) {
      newTop.faceUp = true;
      flipped = true;
    }

    this.state.moves += 1;
    this.state.score -= 1;

    const completions = this.checkCompletions([from, to]);
    this.afterAction();
    return {
      ok: true,
      to,
      count: chunk.length,
      flipped,
      completed: completions.map((c) => c.suit),
      completedIds: completions.flatMap((c) => c.ids),
    };
  }

  /** 从发牌堆发一轮：每列 +1 张明牌 */
  deal(): DealOutcome {
    if (this.state.status === 'won') return { ok: false, reason: 'no-stock' };
    const blocked = dealBlockReason(this.state);
    if (blocked) return { ok: false, reason: blocked };

    this.pushHistory();
    const group = this.state.stock.shift();
    if (!group) return { ok: false, reason: 'no-stock' };

    group.forEach((card, i) => {
      card.faceUp = true;
      this.state.columns[i].push(card);
    });

    this.state.moves += 1;
    this.state.score -= 1;

    const completions = this.checkCompletions(this.state.columns.map((_, i) => i));
    this.afterAction();
    return { ok: true, completed: completions.map((c) => c.suit), completedIds: completions.flatMap((c) => c.ids) };
  }

  /** 双击自动寻位：优先同花色续接 → 非空列 → 空列 */
  autoMoveTarget(from: number, index: number): number | null {
    if (!canPickUp(this.state, from, index)) return null;
    const moving = this.state.columns[from][index];
    const best = this.rankTargets(from, index, moving)
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    return best ? best.column : null;
  }

  autoMove(from: number, index: number): MoveOutcome {
    const target = this.autoMoveTarget(from, index);
    if (target === null) return { ok: false, reason: 'bad-target' };
    return this.move(from, index, target);
  }

  /** 提示：返回当前局面下最值得走的一步 */
  hint(): HintMove | null {
    let best: HintMove | null = null;
    for (let from = 0; from < this.state.columns.length; from += 1) {
      const col = this.state.columns[from];
      for (let index = 0; index < col.length; index += 1) {
        if (!canPickUp(this.state, from, index)) continue;
        const moving = col[index];
        for (const candidate of this.rankTargets(from, index, moving)) {
          if (candidate.score <= 0) continue;
          if (!best || candidate.score > best.score) {
            best = { from, index, to: candidate.column, score: candidate.score };
          }
        }
      }
    }
    return best;
  }

  undo(): boolean {
    const raw = this.history.pop();
    if (!raw) return false;
    const restored = JSON.parse(raw) as GameState;
    restored.elapsedMs = this.state.elapsedMs;
    this.state = restored;
    return true;
  }

  serialize(): string {
    return JSON.stringify(this.state);
  }

  /** 剩余可发次数 */
  get remainingDeals(): number {
    return this.state.stock.length;
  }

  private rankTargets(
    from: number,
    index: number,
    moving: GameState['columns'][number][number],
  ): { column: number; score: number }[] {
    const out: { column: number; score: number }[] = [];
    for (let to = 0; to < this.state.columns.length; to += 1) {
      if (to === from) continue;
      const target = this.state.columns[to];
      if (!canDropOn(target, moving)) continue;

      const top = topCard(target);
      let score = 10;
      if (top && top.suit === moving.suit) score += 50; // 同花色续接，最有用
      if (top) score += 5;
      else score -= 18; // 空列是稀缺资源，尽量留着

      const source = this.state.columns[from];
      const below = source[index - 1];
      if (below && !below.faceUp) score += 45; // 能翻出暗牌
      if (index === 0 && source.length > 1) score += 12; // 能空出一列

      // 把已经成顺的牌挪到不同花色的列上，通常是无效折腾
      if (index > 0 && source[index - 1].faceUp && source[index - 1].suit === moving.suit) {
        score -= 55;
      }
      if (top && top.suit !== moving.suit && moving.rank === top.rank - 1) score -= 6;
      out.push({ column: to, score });
    }
    return out;
  }

  private checkCompletions(columns: number[]): { suit: Suit; ids: number[] }[] {
    const completed: { suit: Suit; ids: number[] }[] = [];
    for (const col of columns) {
      const suit = completedSuit(this.state.columns[col]);
      if (!suit) continue;
      const column = this.state.columns[col];
      const removed = column.splice(column.length - 13, 13);
      this.state.sets.push(suit);
      this.state.score += 100;
      completed.push({ suit, ids: removed.map((c) => c.id) });
      const newTop = topCard(column);
      if (newTop && !newTop.faceUp) newTop.faceUp = true;
    }
    return completed;
  }

  private afterAction(): void {
    if (this.state.sets.length >= TOTAL_SETS) {
      this.state.status = 'won';
      // 通关奖励：剩余时间越少扣得越少，鼓励快速完成
      const timePenalty = Math.floor(this.state.elapsedMs / 10000);
      this.state.score = Math.max(this.state.score, 0) + Math.max(0, 200 - timePenalty);
    }
  }

  private pushHistory(): void {
    this.history.push(JSON.stringify(this.state));
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }
}
