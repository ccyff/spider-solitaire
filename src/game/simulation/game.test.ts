import { describe, expect, it } from 'vitest';
import { SpiderGame } from './game';
import { mulberry32 } from './rng';
import { canDropOn, canPickUp, completedSuit } from './rules';
import type { Card, GameState, Rank, Suit } from './types';
import { COLUMN_COUNT, START_SCORE, TOTAL_SETS } from './types';

/** 一副牌 = 52 张 = 4 组 K→A */
const DECK_SIZE = 52;

function countCards(state: GameState): number {
  const inColumns = state.columns.reduce((sum, col) => sum + col.length, 0);
  const inStock = state.stock.reduce((sum, group) => sum + group.length, 0);
  return inColumns + inStock + state.sets.length * 13;
}

function allIds(state: GameState): number[] {
  return [
    ...state.columns.flat().map((c) => c.id),
    ...state.stock.flat().map((c) => c.id),
  ];
}

let nextId = 5000;
function card(suit: Suit, rank: number, faceUp = true): Card {
  return { id: nextId++, suit, rank: rank as Rank, faceUp };
}

/** 造一个残局：第 0 列 K..2，第 1 列一张黑桃 A，补上 A 即成一顺 */
function nearWinState(completedSets = 2): GameState {
  const columns: Card[][] = Array.from({ length: COLUMN_COUNT }, () => []);
  for (let rank = 13; rank >= 2; rank -= 1) columns[0].push(card('S', rank));
  columns[1].push(card('S', 1));
  for (let col = 2; col < COLUMN_COUNT; col += 1) columns[col].push(card('C', 8, false));
  return {
    version: 1,
    suitCount: 4,
    seed: 1,
    columns,
    stock: [],
    sets: (['H', 'D', 'C', 'S'] as Suit[]).slice(0, completedSets),
    score: 400,
    moves: 10,
    elapsedMs: 0,
    status: 'playing',
  };
}

describe('发牌', () => {
  it('5 列：6/6/5/5/5 上桌，剩 5 轮发牌，一共 52 张', () => {
    const game = SpiderGame.newGame(1, 12345);
    expect(game.state.columns).toHaveLength(5);
    expect(game.state.columns.map((c) => c.length)).toEqual([6, 6, 5, 5, 5]);
    expect(game.state.stock).toHaveLength(5);
    expect(game.state.stock.every((group) => group.length === 5)).toBe(true);
    expect(countCards(game.state)).toBe(DECK_SIZE);
    expect(new Set(allIds(game.state)).size).toBe(DECK_SIZE);
  });

  it('每列只有最上面一张是明牌', () => {
    const game = SpiderGame.newGame(2, 99);
    for (const col of game.state.columns) {
      col.forEach((c, i) => {
        expect(c.faceUp).toBe(i === col.length - 1);
      });
    }
  });

  it('相同 seed 产生完全相同的牌局', () => {
    const a = SpiderGame.newGame(4, 2024);
    const b = SpiderGame.newGame(4, 2024);
    expect(a.serialize()).toBe(b.serialize());
  });

  it('难度决定这副牌的花色构成', () => {
    const one = SpiderGame.newGame(1, 7);
    const oneSuit = one.state.columns.flat().every((c) => c.suit === 'S');
    expect(oneSuit).toBe(true);

    const two = SpiderGame.newGame(2, 7);
    const twoSuits = new Set(two.state.columns.flat().map((c) => c.suit));
    expect(twoSuits.size).toBe(2);

    const four = SpiderGame.newGame(4, 7);
    const suits = new Set(four.state.columns.flat().map((c) => c.suit));
    expect(suits.size).toBe(4);
  });
});

describe('移动规则', () => {
  it('只能拿起同花色且连续递减的明牌序列', () => {
    const state = SpiderGame.newGame(1, 5).state;
    state.columns[0] = [card('S', 5, false), card('S', 9), card('S', 8), card('S', 7)];
    expect(canPickUp(state, 0, 1)).toBe(true);
    expect(canPickUp(state, 0, 3)).toBe(true);
    expect(canPickUp(state, 0, 0)).toBe(false); // 暗牌不能拿

    state.columns[0] = [card('S', 9), card('H', 8)];
    expect(canPickUp(state, 0, 0)).toBe(false); // 花色不同

    state.columns[0] = [card('S', 9), card('S', 7)];
    expect(canPickUp(state, 0, 0)).toBe(false); // 点数不连续
  });

  it('落点必须是比它大 1 点的任意花色，空列可放任意牌', () => {
    expect(canDropOn([card('H', 10)], card('S', 9))).toBe(true);
    expect(canDropOn([card('H', 11)], card('S', 9))).toBe(false);
    expect(canDropOn([], card('S', 9))).toBe(true);
    expect(canDropOn([card('H', 10, false)], card('S', 9))).toBe(false);
  });

  it('移动后翻开新露出的暗牌', () => {
    const game = SpiderGame.newGame(1, 11);
    game.state.columns[0] = [card('S', 5, false), card('S', 9)];
    game.state.columns[1] = [card('H', 10)];
    const source = game.state.columns[0];
    const result = game.move(0, 1, 1);
    expect(result.ok).toBe(true);
    expect(result.flipped).toBe(true);
    expect(source).toHaveLength(1);
    expect(source[0].faceUp).toBe(true);
  });

  it('拒绝非法移动且不改变状态', () => {
    const game = SpiderGame.newGame(1, 13);
    const before = game.serialize();
    const bad = game.move(0, 0, 1);
    expect(bad.ok).toBe(false);
    expect(game.serialize()).toBe(before);
  });

  it('同列内移动被拒绝', () => {
    const game = SpiderGame.newGame(1, 17);
    expect(game.move(0, 0, 0).ok).toBe(false);
  });

  it('可以压在不同花色的牌上，但整段移动必须同花', () => {
    const state = SpiderGame.newGame(1, 3).state;
    state.columns[0] = [card('S', 5), card('H', 4)];
    expect(canPickUp(state, 0, 1)).toBe(true);
    expect(canPickUp(state, 0, 0)).toBe(false);
    state.columns[1] = [card('D', 5)];
    expect(canDropOn(state.columns[1], state.columns[0][1])).toBe(true);
  });
});

describe('收牌与通关', () => {
  it('识别列尾的 K→A 同花顺', () => {
    const run = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((r) => card('H', r));
    expect(completedSuit(run)).toBe('H');
    run[5] = card('S', 8);
    expect(completedSuit(run)).toBeNull();
  });

  it('完成一手得 100 分并把这 13 张牌移出牌面', () => {
    const game = SpiderGame.fromState(nearWinState());
    const before = countCards(game.state);
    const scoreBefore = game.state.score;
    const result = game.move(1, 0, 0);
    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['S']);
    expect(game.state.sets).toHaveLength(3);
    expect(game.state.score).toBe(scoreBefore - 1 + 100);
    expect(countCards(game.state)).toBe(before); // 牌没有消失，只是进了收牌区
    expect(game.state.columns[0]).toHaveLength(0);
  });

  it('凑满 4 组进入通关状态', () => {
    const game = SpiderGame.fromState(nearWinState(TOTAL_SETS - 1));
    expect(game.isWon).toBe(false);
    game.move(1, 0, 0);
    expect(game.isWon).toBe(true);
    expect(game.state.status).toBe('won');
    expect(game.state.score).toBeGreaterThan(0);
  });
});

describe('发牌堆', () => {
  it('发一轮后每列多一张明牌', () => {
    const game = SpiderGame.newGame(1, 21);
    const sizes = game.state.columns.map((c) => c.length);
    const outcome = game.deal();
    expect(outcome.ok).toBe(true);
    expect(game.state.stock).toHaveLength(4);
    game.state.columns.forEach((col, i) => {
      expect(col).toHaveLength(sizes[i] + 1);
      expect(col[col.length - 1].faceUp).toBe(true);
    });
  });

  it('有空列时不能发牌（经典规则）', () => {
    const game = SpiderGame.newGame(1, 23);
    game.state.columns[3] = [];
    const outcome = game.deal();
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('empty-column');
    expect(game.state.stock).toHaveLength(5);
  });

  it('牌堆发空后不能再发', () => {
    const game = SpiderGame.newGame(1, 29);
    game.state.stock = [];
    expect(game.deal().reason).toBe('no-stock');
  });
});

describe('撤销 / 提示 / 自动寻位', () => {
  it('撤销可以完整回退一步', () => {
    const game = SpiderGame.newGame(1, 31);
    const before = game.serialize();
    const outcome = game.autoMove(0, game.state.columns[0].length - 1);
    if (outcome.ok) {
      expect(game.serialize()).not.toBe(before);
      expect(game.undo()).toBe(true);
      expect(game.serialize()).toBe(before);
    }
  });

  it('撤销能回退发牌', () => {
    const game = SpiderGame.newGame(1, 37);
    const before = game.serialize();
    game.deal();
    game.undo();
    expect(game.serialize()).toBe(before);
  });

  it('提示给出的永远是一步合法移动', () => {
    for (let seed = 1; seed < 30; seed += 1) {
      const game = SpiderGame.newGame(4, seed);
      const hint = game.hint();
      if (hint) expect(game.canMove(hint.from, hint.index, hint.to)).toBe(true);
    }
  });

  it('自动寻位优先续接同花色', () => {
    const state = SpiderGame.newGame(1, 41).state;
    state.columns[0] = [card('S', 9)];
    state.columns[1] = [card('D', 10)];
    state.columns[2] = [card('S', 10)];
    const game = SpiderGame.fromState(state);
    expect(game.autoMoveTarget(0, 0)).toBe(2);
  });
});

describe('随机对局压力测试', () => {
  it('随机走 250 步不会破坏牌数守恒或不变量', () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const suits = (seed % 3 === 0 ? 1 : seed % 3 === 1 ? 2 : 4) as 1 | 2 | 4;
      const game = SpiderGame.newGame(suits, seed * 977);
      const rand = mulberry32(seed);
      for (let step = 0; step < 250 && !game.isWon; step += 1) {
        if (rand() < 0.1) {
          game.deal();
        } else {
          const from = Math.floor(rand() * COLUMN_COUNT);
          const col = game.state.columns[from];
          if (col.length === 0) continue;
          const index = Math.floor(rand() * col.length);
          game.move(from, index, Math.floor(rand() * COLUMN_COUNT));
        }
        expect(countCards(game.state)).toBe(DECK_SIZE);
        expect(new Set(allIds(game.state)).size).toBe(allIds(game.state).length);
        const expected = START_SCORE - game.state.moves + game.state.sets.length * 100;
        if (!game.isWon) expect(game.state.score).toBe(expected);
        expect(game.state.sets.length).toBeLessThanOrEqual(TOTAL_SETS);
      }
    }
  });

  it('每一局开始都至少有一张能动的牌或能发的牌堆', () => {
    for (let seed = 1; seed < 40; seed += 1) {
      const game = SpiderGame.newGame(1, seed);
      expect(game.hasMove || game.remainingDeals > 0).toBe(true);
    }
  });
});
