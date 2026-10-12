import type { GameState } from '../game/simulation/types';
import { DIFFICULTY_LABEL, TOTAL_SETS } from '../game/simulation/types';
import { formatDuration } from '../input/bindings';
import { el } from './dom';

export interface HudFlags {
  canUndo: boolean;
  canDeal: boolean;
}

export interface HudCallbacks {
  onDeal(): void;
  onUndo(): void;
  onHint(): void;
  onToggleSound(): void;
  onMenu(): void;
}

/** 常驻顶栏：分数 / 步数 / 时间 / 进度 + 主要操作按钮 */
export class Hud {
  private scoreValue: HTMLElement;
  private movesValue: HTMLElement;
  private timeValue: HTMLElement;
  private progressValue: HTMLElement;
  private difficultyChip: HTMLElement;
  private dealButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private soundButton: HTMLButtonElement;
  private timer: number | null = null;

  constructor(
    root: HTMLElement,
    private callbacks: HudCallbacks,
    private getElapsed: () => number,
  ) {
    this.difficultyChip = el('div', { class: 'chip', text: '1 花色 · 简单' });
    this.scoreValue = el('span', { class: 'stat__value', text: '500' });
    this.movesValue = el('span', { class: 'stat__value', text: '0' });
    this.timeValue = el('span', { class: 'stat__value', text: '00:00' });
    this.progressValue = el('span', { class: 'stat__value', text: `0/${TOTAL_SETS}` });

    this.dealButton = el('button', {
      class: 'btn',
      attrs: { type: 'button', title: '发一轮牌（空格）' },
      on: { click: () => this.callbacks.onDeal() },
    }, [
      el('span', { text: '发牌 ' }),
      el('span', { class: 'btn__label--wide', text: 'D' }),
    ]);
    this.undoButton = el('button', {
      class: 'btn',
      attrs: { type: 'button', title: '撤销上一步（U）' },
      on: { click: () => this.callbacks.onUndo() },
    }, [
      el('span', { text: '撤销 ' }),
      el('span', { class: 'btn__label--wide', text: 'U' }),
    ]);
    const hintButton = el('button', {
      class: 'btn',
      attrs: { type: 'button', title: '给出建议（H）' },
      on: { click: () => this.callbacks.onHint() },
    }, [
      el('span', { text: '提示 ' }),
      el('span', { class: 'btn__label--wide', text: 'H' }),
    ]);
    this.soundButton = el('button', {
      class: 'btn btn--icon',
      attrs: { type: 'button', title: '音效开关（M）', 'aria-pressed': 'true' },
      on: { click: () => this.callbacks.onToggleSound() },
    }, ['🔊']);
    const menuButton = el('button', {
      class: 'btn btn--icon',
      attrs: { type: 'button', title: '菜单' },
      on: { click: () => this.callbacks.onMenu() },
    }, ['☰']);

    const hud = el('header', { class: 'hud', attrs: { role: 'banner' } }, [
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand__mark', text: '♠' }),
        el('span', { class: 'brand__name', text: '蜘蛛纸牌' }),
      ]),
      this.difficultyChip,
      el('div', { class: 'hud__stats' }, [
        this.stat('分数', this.scoreValue),
        this.stat('步数', this.movesValue),
        this.stat('时间', this.timeValue),
        this.stat('进度', this.progressValue, 'stat stat--progress'),
      ]),
      el('div', { class: 'hud__actions' }, [
        this.dealButton,
        this.undoButton,
        hintButton,
        this.soundButton,
        menuButton,
      ]),
    ]);

    root.replaceChildren(hud);
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
    this.dealButton.disabled = !flags.canDeal;
    this.undoButton.disabled = !flags.canUndo;
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
