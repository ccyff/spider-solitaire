import { playSfx } from '../audio/sfx';
import {
  DIFFICULTY_LABEL,
  SUIT_LABEL,
  TOTAL_SETS,
  type GameState,
  type SuitCount,
} from '../game/simulation/types';
import { formatDuration } from '../input/bindings';
import { button, el } from './dom';

/** 覆盖层栈：负责遮罩、ESC/点击遮罩关闭，并通知外部暂停牌桌 */
export class Overlays {
  private stack: HTMLElement[] = [];

  constructor(private layer: HTMLElement, private onOpenChange: (open: boolean) => void) {}

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  open(panel: HTMLElement, options: { dismissible?: boolean } = {}): void {
    const dismissible = options.dismissible !== false;
    const overlay = el('div', { class: 'overlay' }, [panel]);
    if (dismissible) {
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) this.close(overlay);
      });
    }
    this.layer.append(overlay);
    this.layer.classList.add('is-open');
    this.stack.push(overlay);
    this.onOpenChange(true);
    const focusTarget = panel.querySelector<HTMLElement>('[data-autofocus]');
    (focusTarget ?? panel).focus?.();
  }

  closeTop(): void {
    const top = this.stack[this.stack.length - 1];
    if (top) this.close(top);
  }

  closeAll(): void {
    [...this.stack].forEach((overlay) => this.close(overlay));
  }

  private close(overlay: HTMLElement): void {
    this.stack = this.stack.filter((item) => item !== overlay);
    overlay.remove();
    if (this.stack.length === 0) this.layer.classList.remove('is-open');
    this.onOpenChange(this.stack.length > 0);
  }
}

export function showToast(
  layer: HTMLElement,
  text: string,
  tone: 'info' | 'warn' | 'good' = 'info',
): void {
  const node = el('div', {
    class: `toast${tone === 'info' ? '' : ` toast--${tone}`}`,
    text,
  });
  layer.append(node);
  window.setTimeout(() => {
    node.classList.add('toast--out');
    window.setTimeout(() => node.remove(), 260);
  }, 2300);
}

// ------------------------------------------------------------------ 组件

function panelShell(children: (Node | string)[], options: { close?: () => void } = {}): HTMLElement {
  const panel = el(
    'div',
    { class: 'panel', attrs: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' } },
    children,
  );
  if (options.close) {
    panel.append(
      el('button', {
        class: 'panel__close',
        text: '✕',
        attrs: { type: 'button', 'aria-label': '关闭' },
        on: { click: options.close },
      }),
    );
  }
  return panel;
}

function switchRow(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const input = el('input', {
    attrs: { type: 'checkbox' },
    on: {
      change: () => {
        playSfx('click');
        onChange(input.checked);
      },
    },
  });
  input.checked = checked;
  return el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'switch__track' }),
    el('span', { text: label }),
  ]);
}

function row(label: string, value: string): HTMLElement {
  return el('div', { class: 'panel__row' }, [
    el('span', { text: label }),
    el('span', { class: 'panel__row-value', text: value }),
  ]);
}

// ------------------------------------------------------------------ 开局面板

export interface StartPanelOptions {
  hasSave: boolean;
  suitCount: SuitCount;
  bestFor(suitCount: SuitCount): number;
  sfx: boolean;
  music: boolean;
  haptics: boolean;
  onStart(kind: 'new' | 'continue', suitCount: SuitCount): void;
  onToggleSfx(value: boolean): void;
  onToggleMusic(value: boolean): void;
  onToggleHaptics(value: boolean): void;
  onHelp(): void;
}

export function openStartPanel(overlays: Overlays, options: StartPanelOptions): void {
  let selected = options.suitCount;

  const difficulties = {} as Record<SuitCount, HTMLButtonElement>;
  const noteLine = el('p', { class: 'panel__subtitle' });

  const describe = (): void => {
    const notes: Record<SuitCount, string> = {
      1: '整副牌都是黑桃，只要点数连得上就行，适合第一次玩。',
      2: '黑桃与红桃交错，需要留意花色是否连成一段。',
      4: '四种花色齐全，只有同花色的连续牌才能整段搬动。',
    };
    const best = options.bestFor(selected);
    noteLine.textContent = best > 0 ? `${notes[selected]} 该难度最高分 ${best}。` : notes[selected];
  };

  const list = el('div', { class: 'difficulty-list' });
  ([1, 2, 4] as SuitCount[]).forEach((count) => {
    const best = options.bestFor(count);
    const node = el(
      'button',
      {
        class: 'difficulty',
        attrs: { type: 'button', 'aria-pressed': String(count === selected) },
        on: {
          click: () => {
            playSfx('click');
            selected = count;
            for (const key of Object.keys(difficulties) as unknown as SuitCount[]) {
              difficulties[key].setAttribute('aria-pressed', String(Number(key) === count));
            }
            describe();
          },
        },
      },
      [
        el('span', { class: 'difficulty__name', text: DIFFICULTY_LABEL[count] }),
        el('span', { class: 'difficulty__meta', text: best > 0 ? `最高 ${best} 分` : '未挑战' }),
      ],
    );
    difficulties[count] = node;
    list.append(node);
  });
  describe();

  const actions = el('div', { class: 'panel__actions' });
  if (options.hasSave) {
    actions.append(
      button('继续上一局', 'btn btn--gold', () => {
        playSfx('click');
        options.onStart('continue', selected);
      }),
    );
    actions.append(
      button('开始新局', 'btn', () => {
        playSfx('click');
        options.onStart('new', selected);
      }),
    );
  } else {
    actions.append(
      button('开始新局', 'btn btn--gold', () => {
        playSfx('click');
        options.onStart('new', selected);
      }),
    );
  }

  const panel = panelShell([
    el('div', { class: 'panel__eyebrow', text: 'Spider Solitaire' }),
    el('h1', { class: 'panel__title', text: '蜘蛛纸牌' }),
    el('p', {
      class: 'panel__subtitle',
      text: '把桌面上的牌整理成 8 组同花 K→A。拖动或用点击选牌，双击任意明牌可以自动归位。',
    }),
    el('div', { class: 'panel__section-title', text: '选择难度' }),
    list,
    noteLine,
    el('div', { class: 'panel__section-title', text: '声音' }),
    el('div', { class: 'panel__rows' }, [
      el('div', { class: 'panel__row' }, [
        switchRow('音效', options.sfx, options.onToggleSfx),
        switchRow('背景音乐', options.music, options.onToggleMusic),
      ]),
      el('div', { class: 'panel__row' }, [switchRow('震动反馈（手机）', options.haptics, options.onToggleHaptics)]),
    ]),
    actions,
    el('div', { class: 'panel__actions' }, [
      button('玩法说明', 'btn btn--ghost', () => {
        playSfx('click');
        options.onHelp();
      }),
    ]),
  ]);

  overlays.open(panel, { dismissible: options.hasSave });
}

// ------------------------------------------------------------------ 玩法说明

export function openHelpPanel(overlays: Overlays): void {
  const close = (): void => {
    playSfx('click');
    overlays.closeTop();
  };
  const panel = panelShell(
    [
      el('div', { class: 'panel__eyebrow', text: 'How to play' }),
      el('h2', { class: 'panel__title', text: '玩法说明' }),
      el('ol', { class: 'rules' }, [
        el('li', { html: '桌面共 <b>10 列</b>，目标是把所有牌整理成 <b>8 组同花 K→A</b>。' }),
        el('li', { html: '可以整段搬动<b>同花色且连续递减</b>的牌；落点必须比它大 1 点（花色不限）。' }),
        el('li', { html: '空列能放任意牌或任意合法的一段牌，留空格是这门牌的关键技巧。' }),
        el('li', { html: '点左上角牌堆或按 <b>空格</b> 发一轮牌，每列各加一张明牌。' }),
        el('li', { html: '必须所有列都非空才能发牌；牌堆一共 5 轮，发完就只剩桌面上的牌。' }),
        el('li', { html: '凑成同花 K→A 会自动收走，<b>每组 +100 分</b>，每次操作 -1 分。' }),
        el('li', { html: '<b>操作：</b>拖动牌；点击选中后再点目标列；双击任意明牌自动归位。' }),
      el('li', { html: '<b>快捷键：</b>空格/D 发牌，U 撤销，H 提示，N 新局，M 静音，Esc 返回。' }),
      ]),
      el('p', {
        class: 'panel__credit',
        html: '牌面素材：Playing Cards by Ryan Dansie / Iron Star Media，CC BY 3.0（via OpenGameArt）。',
      }),
      el('div', { class: 'panel__actions' }, [button('知道了', 'btn btn--gold', close)]),
    ],
    { close },
  );
  overlays.open(panel);
}

// ------------------------------------------------------------------ 菜单

export interface MenuOptions {
  sfx: boolean;
  music: boolean;
  haptics: boolean;
  elapsedMs: number;
  onResume(): void;
  onNewGame(): void;
  onHelp(): void;
  onToggleSfx(value: boolean): void;
  onToggleMusic(value: boolean): void;
  onToggleHaptics(value: boolean): void;
}

export function openMenuPanel(overlays: Overlays, options: MenuOptions): void {
  const panel = panelShell(
    [
      el('div', { class: 'panel__eyebrow', text: 'Paused' }),
      el('h2', { class: 'panel__title', text: '菜单' }),
      el('p', { class: 'panel__subtitle', text: '计时已经暂停，随时可以回来继续。' }),
      el('div', { class: 'panel__rows' }, [
        row('本局用时', formatDuration(options.elapsedMs)),
        el('div', { class: 'panel__row' }, [
          switchRow('音效', options.sfx, options.onToggleSfx),
          switchRow('背景音乐', options.music, options.onToggleMusic),
        ]),
        el('div', { class: 'panel__row' }, [
          switchRow('震动反馈（手机）', options.haptics, options.onToggleHaptics),
        ]),
      ]),
      el('div', { class: 'panel__actions' }, [
        button('继续游戏', 'btn btn--gold', () => {
          playSfx('click');
          options.onResume();
        }),
        button('重开一局', 'btn', () => {
          playSfx('click');
          options.onNewGame();
        }),
      ]),
      el('div', { class: 'panel__actions' }, [
        button('玩法说明', 'btn btn--ghost', () => {
          playSfx('click');
          options.onHelp();
        }),
      ]),
    ],
    {
      close: () => {
        playSfx('click');
        options.onResume();
      },
    },
  );
  overlays.open(panel);
}

// ------------------------------------------------------------------ 通关

export interface WinOptions {
  state: GameState;
  best: number;
  isRecord: boolean;
  onPlayAgain(): void;
  onChangeDifficulty(): void;
}

export function openWinPanel(overlays: Overlays, options: WinOptions): void {
  const { state } = options;
  const suits = el('div', { class: 'win-suits' });
  state.sets.forEach((suit) => suits.append(el('span', { text: SUIT_LABEL[suit] })));
  for (let i = state.sets.length; i < TOTAL_SETS; i += 1) {
    suits.append(el('span', { text: '♤', style: { opacity: '0.28' } }));
  }

  const panel = panelShell([
    el('div', { class: 'panel__eyebrow', text: options.isRecord ? 'New Record' : 'Complete' }),
    el('h2', {
      class: 'panel__title',
      text: options.isRecord ? '新纪录 · 全部清空' : '通关！',
    }),
    suits,
    el('div', { class: 'panel__rows' }, [
      row('最终得分', String(state.score)),
      row('用时', formatDuration(state.elapsedMs)),
      row('操作步数', String(state.moves)),
      row('历史最佳', String(Math.max(options.best, state.score))),
    ]),
    el('div', { class: 'panel__actions' }, [
      button('再来一局', 'btn btn--gold', () => {
        playSfx('click');
        options.onPlayAgain();
      }),
      button('换难度', 'btn', () => {
        playSfx('click');
        options.onChangeDifficulty();
      }),
    ]),
  ]);
  overlays.open(panel, { dismissible: false });
}
