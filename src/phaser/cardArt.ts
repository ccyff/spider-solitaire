import type { Rank, Suit } from '../game/simulation/types';

/**
 * 牌面素材：一套现成的标准扑克牌（不是手绘），已经裁切、缩放、拼成一张图集。
 *
 *   public/assets/cards/atlas.png   2600x1385，13 列 x 5 行
 *   行序：0 黑桃 / 1 红桃 / 2 方块 / 3 梅花，每行 A→K；第 5 行第 1 格是牌背
 *
 * 授权：CC-BY 3.0（作者 ryan.dansie / Iron Star Media，来自 OpenGameArt），
 * 详见 public/assets/cards/ATTRIBUTION.txt，请勿删除该说明。
 */

export interface TextureSink {
  textures: {
    exists(key: string): boolean;
    addCanvas(key: string, canvas: HTMLCanvasElement): unknown;
  };
}

export const ATLAS = {
  key: 'card-atlas',
  url: 'assets/cards/atlas.png',
  cols: 13,
  rows: 5,
  /** 图集里每一格的尺寸 */
  cellW: 200,
  cellH: 277,
  /** 格子里真正的牌面尺寸（右侧/底部留了几像素放投影） */
  cardW: 194,
  cardH: 269,
} as const;

/** 图集行序：黑桃 / 红桃 / 方块 / 梅花 */
export const ATLAS_ROW: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3 };

/** 牌背所在的格子 */
export const ATLAS_BACK = { col: 0, row: 4 } as const;

/** 纹理尺寸 = 整格（含投影余量） */
export const ART_W = ATLAS.cellW;
export const ART_H = ATLAS.cellH;

/** 真实牌面的宽高比，牌桌布局用它算出每张牌显示多大 */
export const CARD_RATIO = ATLAS.cardH / ATLAS.cardW;

/** 精灵原点要落在「牌面中心」而不是格子中心，这样带投影的格子也不会让牌位偏移 */
export const CARD_ORIGIN_X = ATLAS.cardW / 2 / ATLAS.cellW;
export const CARD_ORIGIN_Y = ATLAS.cardH / 2 / ATLAS.cellH;

/** 让「看得见的牌面」正好等于给定宽度时，纹理需要乘上的比例 */
export const CELL_SCALE_X = ATLAS.cellW / ATLAS.cardW;
export const CELL_SCALE_Y = ATLAS.cellH / ATLAS.cardH;

export const TEX = {
  card: (suit: Suit, rank: Rank) => `card_${suit}_${rank}`,
  back: 'card_back',
  slot: 'slot_empty',
  foundation: 'slot_foundation',
  spark: 'fx_spark',
  ring: 'fx_ring',
  glow: 'fx_glow',
  highlight: 'fx_highlight',
} as const;

// ------------------------------------------------------------------ 工具

function createCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
  return { canvas, ctx };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function addTexture(target: TextureSink, key: string, canvas: HTMLCanvasElement): void {
  if (target.textures.exists(key)) return;
  target.textures.addCanvas(key, canvas);
}

function radialSprite(size: number, stops: [number, string][]): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(size, size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

// ------------------------------------------------------------------ 图集切分

/** 把图集里的一格裁成独立纹理 */
function cropCell(atlas: CanvasImageSource, col: number, row: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(ATLAS.cellW, ATLAS.cellH);
  ctx.drawImage(
    atlas,
    col * ATLAS.cellW,
    row * ATLAS.cellH,
    ATLAS.cellW,
    ATLAS.cellH,
    0,
    0,
    ATLAS.cellW,
    ATLAS.cellH,
  );
  return canvas;
}

/**
 * 启动时把图集切成 52 张牌面 + 1 张牌背。
 * 之后再销毁图集本身，显存里只留实际会用到的纹理。
 */
export function buildCardTextures(target: TextureSink, atlas: CanvasImageSource): void {
  for (const suit of Object.keys(ATLAS_ROW) as Suit[]) {
    const row = ATLAS_ROW[suit];
    for (let rank = 1; rank <= 13; rank += 1) {
      addTexture(target, TEX.card(suit, rank as Rank), cropCell(atlas, rank - 1, row));
    }
  }
  addTexture(target, TEX.back, cropCell(atlas, ATLAS_BACK.col, ATLAS_BACK.row));
}

// ------------------------------------------------------------------ 界面与特效贴图

function drawSlot(ctx: CanvasRenderingContext2D, stroke: string, fill: string): void {
  ctx.save();
  roundRect(ctx, 4, 4, ART_W - 8, ART_H - 8, 16);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.setLineDash([11, 9]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

/** 选中 / 提示用的柔和暖光（刻意不做硬边框，避免在牌桌上过于扎眼） */
function drawHighlight(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  const layers: [number, number][] = [
    [20, 0.06],
    [13, 0.085],
    [7, 0.11],
  ];
  for (const [width, alpha] of layers) {
    roundRect(ctx, 14, 14, ART_W - 28, ART_H - 28, 20);
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(255,213,139,${alpha})`;
    ctx.stroke();
  }
  roundRect(ctx, 14, 14, ART_W - 28, ART_H - 28, 20);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(255,231,183,0.28)';
  ctx.stroke();
  ctx.restore();
}

/** 牌位、提示光、粒子等界面贴图仍然是画出来的（这些不是牌面） */
export function buildFxTextures(target: TextureSink): void {
  const slot = createCanvas(ART_W, ART_H);
  drawSlot(slot.ctx, 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0.03)');
  addTexture(target, TEX.slot, slot.canvas);

  const foundation = createCanvas(ART_W, ART_H);
  drawSlot(foundation.ctx, 'rgba(201,164,92,0.42)', 'rgba(201,164,92,0.05)');
  addTexture(target, TEX.foundation, foundation.canvas);

  addTexture(
    target,
    TEX.spark,
    radialSprite(40, [
      [0, 'rgba(255,255,255,1)'],
      [0.35, 'rgba(255,236,190,0.85)'],
      [1, 'rgba(255,220,150,0)'],
    ]),
  );

  const ring = createCanvas(96, 96);
  ring.ctx.strokeStyle = 'rgba(255,236,190,0.95)';
  ring.ctx.lineWidth = 6;
  ring.ctx.beginPath();
  ring.ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ring.ctx.stroke();
  addTexture(target, TEX.ring, ring.canvas);

  addTexture(
    target,
    TEX.glow,
    radialSprite(256, [
      [0, 'rgba(255,240,200,0.55)'],
      [0.5, 'rgba(255,220,140,0.18)'],
      [1, 'rgba(255,200,100,0)'],
    ]),
  );

  const highlight = createCanvas(ART_W, ART_H);
  drawHighlight(highlight.ctx);
  addTexture(target, TEX.highlight, highlight.canvas);
}
