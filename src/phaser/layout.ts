import { CARD_RATIO } from './cardArt';
import { COLUMN_COUNT, TOTAL_SETS, type Card } from '../game/simulation/types';

export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardLayout {
  width: number;
  height: number;
  cardW: number;
  cardH: number;
  /** 每列中心 x */
  columnX: number[];
  columnTopY: number;
  /** 同列内相邻两张明牌 / 暗牌的纵向偏移 */
  fanUp: number;
  fanDown: number;
  stock: SlotRect;
  foundations: SlotRect[];
  foundationScale: number;
  tableauBottom: number;
  padTop: number;
}

/** 5 列之后牌可以放得很大，这里给桌面端留个上限（牌面素材是 194px 宽，别拉太糊） */
const MAX_CARD_W = 132;
/** 下限取得足够小，保证所有列在最窄的手机上也能完整放下（宁可小，也不要溢出看不见） */
const MIN_CARD_W = 22;
const GAP_RATIO = 0.13;
const FAN_UP_RATIO = 0.27;
const FAN_DOWN_RATIO = 0.135;

/**
 * 根据可视区域算出整张牌桌的几何布局。
 * 列宽铺满宽度，纵向偏移会根据最长的一列自动压缩，保证任何屏幕都完整可见。
 */
export function computeLayout(width: number, height: number, columns: Card[][]): BoardLayout {
  const padX = clamp(width * 0.018, 6, 26);
  const padTop = clamp(height * 0.018, 6, 20);
  const padBottom = clamp(height * 0.02, 8, 24);

  const availW = width - padX * 2;
  const rawCardW = availW / (COLUMN_COUNT + (COLUMN_COUNT - 1) * GAP_RATIO);

  /**
   * 高度也要卡住：顶栏（发牌堆/收牌位）要占一张牌高，牌列至少要能放下
   * 「一张牌 + 最小叠放间距」，否则横屏或矮窗口里牌会画到屏幕外。
   */
  const verticalBudget = height - padTop - padBottom;
  const maxCardHByHeight = Math.max(60, (verticalBudget - 24) / 2.45);
  const cardW = clamp(
    Math.min(rawCardW, maxCardHByHeight / CARD_RATIO),
    MIN_CARD_W,
    MAX_CARD_W,
  );
  const cardH = cardW * CARD_RATIO;
  const gapX = cardW * GAP_RATIO;
  const pitch = cardW + gapX;
  const boardW = cardW * COLUMN_COUNT + gapX * (COLUMN_COUNT - 1);
  const boardLeft = (width - boardW) / 2;

  const columnX: number[] = [];
  for (let i = 0; i < COLUMN_COUNT; i += 1) {
    columnX.push(boardLeft + cardW / 2 + i * pitch);
  }

  // 顶栏：左边发牌堆，右边收牌位（缩小到 0.62 倍，给牌面留空间）
  const foundationScale = 0.62;
  const fw = cardW * foundationScale;
  const fh = cardH * foundationScale;
  const fGap = fw * 0.16;
  const foundations: SlotRect[] = [];
  const fRight = boardLeft + boardW;
  for (let i = TOTAL_SETS - 1; i >= 0; i -= 1) {
    foundations.unshift({
      x: fRight - fw - i * (fw + fGap),
      y: padTop + (cardH - fh) / 2,
      w: fw,
      h: fh,
    });
  }

  const topRowY = padTop;
  const stock: SlotRect = { x: boardLeft, y: topRowY, w: cardW, h: cardH };
  const columnTopY = topRowY + cardH + clamp(cardH * 0.22, 8, 26);
  const tableauBottom = height - padBottom;

  const { up, down, maxExtra } = fitFans(columns, cardH, tableauBottom - columnTopY);

  // 列变短以后，牌列会在下方留出大片空白：把整块牌列在剩余空间里略微靠上居中，更稳
  const slack = Math.max(0, tableauBottom - columnTopY - (cardH + maxExtra));
  const alignedTop = columnTopY + slack * 0.4;

  return {
    width,
    height,
    cardW,
    cardH,
    columnX,
    columnTopY: alignedTop,
    fanUp: up,
    fanDown: down,
    stock,
    foundations,
    foundationScale,
    tableauBottom,
    padTop,
  };
}

/** 纵向偏移：先按好看的比例给，放不下就等比压缩（有下限，避免糊成一团） */
function fitFans(
  columns: Card[][],
  cardH: number,
  available: number,
): { up: number; down: number; maxExtra: number } {
  const baseUp = cardH * FAN_UP_RATIO;
  const baseDown = cardH * FAN_DOWN_RATIO;
  const minUp = cardH * 0.085;
  const minDown = cardH * 0.05;

  const stats = columns.map((column) => {
    let up = 0;
    let down = 0;
    for (let i = 0; i < column.length - 1; i += 1) {
      if (column[i].faceUp) up += 1;
      else down += 1;
    }
    return { up, down };
  });
  const maxUnits = Math.max(
    0,
    ...stats.map((s) => s.up * FAN_UP_RATIO + s.down * FAN_DOWN_RATIO),
  );

  const room = available - cardH;
  let up = baseUp;
  let down = baseDown;
  if (maxUnits <= 0 || room <= 0) {
    up = minUp;
    down = minDown;
  } else {
    const needed = maxUnits * cardH;
    if (needed > room) {
      const k = room / needed;
      up = Math.max(minUp, baseUp * k);
      down = Math.max(minDown, baseDown * k);
    }
  }

  const maxExtra = Math.max(0, ...stats.map((s) => s.up * up + s.down * down));
  return { up, down, maxExtra };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
