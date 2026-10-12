import type { GameState } from '../game/simulation/types';
import { DIFFICULTY_LABEL, TOTAL_SETS } from '../game/simulation/types';
import { formatDuration } from '../input/bindings';
import { el } from './dom';

export interface HudFlags {
  canUndo: boolean;
  canDeal: boolean;
  /** 还能发几轮，显示在发牌按钮上 */
  dealsLeft: number;
}

export interface HudCallbacks {
  onDeal(): void;
  onUndo(): void;
  onHint(): void;
  onToggleSound(): void;
  onMenu(): void;
}

/**
 * 手机优先的界面骨架：
 *   顶部只放「看」的信息（分数 / 步数 / 时间 / 进度），
 *   所有「点」的操作都下沉到屏幕底部的拇指区，发牌放在右下角。
 */
export class Hud {
  private scoreValue: HTMLElement;
  private movesValue: HTMLElement;
  private timeValue: HTMLElement;
  private progressValue: HTMLElement;
  private difficultyChip: HTMLElement;
  private dealButton: HTMLButtonElement;
  private dealBadge: HTMLElement;
  private undoButton: HTMLButtonElement;
  private soundButton: HTMLButtonElement;
  private timer: number | null = null;

  constructor(
    private headerRoot: HTMLElement,
    private dockRoot: HTMLElement,
    private callbacks: HudCallbacks,
    private getElapsed: () => number,
  ) {
    this.difficultyChip = el('div', { class: 'chip', text: '1 花色 · 简单' });
    this.scoreValue = el('span', { class: 'stat__value', text: '500' });
    this.movesValue = el('span', { class: 'stat__value', text: '0' });
    this.timeValue = el('span', { class: 'stat__value', text: '00:00' });
    this.progressValue = el('span', { class: 'stat__value', text: `0/${TOTAL_SETS}` });

    const menuButton = el(
      'button',
      {
        class: 'hud__menu',
        text: '☰',
        attrs: { type: 'button', 'aria-label': '菜单' },
        on: { click: () => this.callbacks.onMenu() },
      },
    );

    const header = el('header', { class: 'hud', attrs: { role: 'banner' } }, [
      el('div', { class: 'hud__brand' }, [
        el('span', { class: 'hud__mark', text: '♠' }),
        el('span', { class: 'hud__title', text: '蜘蛛纸牌' }),
      ]),
      this.difficultyChip,
      el('div', { class: 'hud__stats' }, [
        this.stat('分数', this.scoreValue),
        this.stat('步数', this.movesValue),
        this.stat('时间', this.timeValue),
        this.stat('进度', this.progressValue, 'stat stat--progress'),
      ]),
      menuButton,
    ]);

    this.undoButton = el(
      'button',
      {
        class: 'dock__btn',
        attrs: { type: 'button' },
        on: { click: () => this.callbacks.onUndo() },
      },
      [el('span', { class: 'dock__icon', text: '↶' }), el('span', { text: '撤销' })],
    );
    const hintButton = el(
      'button',
      {
        class: 'dock__btn',
        attrs: { type: 'button' },
        on: { click: () => this.callbacks.onHint() },
      },
      [el('span', { class: 'dock__icon', text: '◑' }), el('span', { text: '提示' })],
    );
    this.soundButton = el(
      'button',
      {
        class: 'dock__btn dock__btn--icon',
        text: '🔊',
        attrs: { type: 'button', 'aria-label': '声音开关', 'aria-pressed': 'true' },
        on: { click: () => this.callbacks.onToggleSound() },
      },
    );

    this.dealBadge = el('span', { class: 'dock__badge', text: '5' });
    this.dealButton = el(
      'button',
      {
        class: 'dock__deal',
        attrs: { type: 'button', 'aria-label': '发一轮牌' },
        on: { click: () => this.callbacks.onDeal() },
      },
      [el('span', { class: 'dock__deal-label', text: '发牌' }), this.dealBadge],
    );

    const dock = el('footer', { class: 'dock', attrs: { role: 'toolbar' } }, [
      el('div', { class: 'dock__group' }, [this.undoButton, hintButton, this.soundButton]),
      el('div', { class: 'dock__spacer' }),
      this.dealButton,
    ]);

    // 顶栏和底部操作坞是两个独立的容器：操作坞必须排在牌桌之后，才是真正的「屏幕底部」
    this.headerRoot.replaceChildren(header);
    this.dockRoot.replaceChildren(dock);
    this.timer = window.setInterval(() => this.renderTime(), 500);
  }

  private stat(label: string, value: HTMLElement, className = 'stat'): HTMLElement {
    return el('div', { class: className }, [
      el('span', { class: 'stat__label', text: label }),
      value,
    ]);
  }

  update(state: GameState, flags: HudFlags): void {
    this.scoreValue.textContent = String(state.score);
    this.movesValue.textContent = String(state.moves);
    this.progressValue.textContent = `${state.sets.length}/${TOTAL_SETS}`;
    this.difficultyChip.textContent = DIFFICULTY_LABEL[state.suitCount];
    this.undoButton.disabled = !flags.canUndo;
    this.dealButton.disabled = !flags.canDeal;
    this.dealBadge.textContent = String(flags.dealsLeft);
    this.dealBadge.hidden = !flags.canDeal;
    this.renderTime();
  }

  setSound(on: boolean): void {
    this.soundButton.textContent = on ? '🔊' : '🔇';
    this.soundButton.setAttribute('aria-pressed', String(on));
  }

  private renderTime(): void {
    this.timeValue.textContent = formatDuration(this.getElapsed());
  }

  destroy(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}
