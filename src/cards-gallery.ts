import { ATLAS, ATLAS_BACK, ATLAS_ROW } from './phaser/cardArt';
import { SUIT_NAME_ZH, rankLabel, type Rank, type Suit } from './game/simulation/types';

/**
 * 独立的全牌面预览页：直接把牌面图集按格裁出来铺在页面上。
 * 这个页面不加载 Phaser，用来快速核对素材是否裁切正确。
 */

const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const root = document.getElementById('gallery');

function figure(canvas: HTMLCanvasElement, caption: string): HTMLElement {
  const wrap = document.createElement('figure');
  wrap.append(canvas);
  const label = document.createElement('figcaption');
  label.textContent = caption;
  wrap.append(label);
  return wrap;
}

function crop(atlas: HTMLImageElement, col: number, row: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS.cellW;
  canvas.height = ATLAS.cellH;
  const ctx = canvas.getContext('2d');
  ctx?.drawImage(
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

if (root) {
  const atlas = new Image();
  atlas.src = ATLAS.url;
  void atlas.decode().then(() => {
    for (const suit of SUITS) {
      const heading = document.createElement('h2');
      heading.textContent = SUIT_NAME_ZH[suit];
      root.append(heading);

      const row = document.createElement('div');
      row.className = 'row';
      for (let rank = 1; rank <= 13; rank += 1) {
        row.append(
          figure(
            crop(atlas, rank - 1, ATLAS_ROW[suit]),
            `${suit}${rankLabel(rank as Rank)}`,
          ),
        );
      }
      root.append(row);
    }

    const heading = document.createElement('h2');
    heading.textContent = '牌背';
    root.append(heading);
    const row = document.createElement('div');
    row.className = 'row';
    row.append(figure(crop(atlas, ATLAS_BACK.col, ATLAS_BACK.row), '牌背'));
    root.append(row);
  });
}
