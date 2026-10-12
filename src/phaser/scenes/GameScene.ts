import Phaser from 'phaser';
import { playSfx } from '../../audio/sfx';
import { bus } from '../../core/bus';
import { haptic } from '../../core/haptics';
import { SpiderGame } from '../../game/simulation/game';
import { canPickUp } from '../../game/simulation/rules';
import type { Card, Suit } from '../../game/simulation/types';
import { CARD_ORIGIN_X, CARD_ORIGIN_Y, CELL_SCALE_X, CELL_SCALE_Y, TEX } from '../cardArt';
import { computeLayout, type BoardLayout } from '../layout';

const DEPTH = {
  slot: 1,
  stockBack: 20,
  card: 100,
  highlight: 5000,
  dragging: 9000,
  fx: 15000,
  label: 16000,
};

const UI_FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif';
const MOVE_MS = 190;
/** 双击判定窗口：手机上比鼠标需要更宽容一点 */
const CLICK_WINDOW_MS = 380;

interface CardLocation {
  col: number;
  index: number;
}

interface DragState {
  from: number;
  index: number;
  ids: number[];
  base: { x: number; y: number }[];
  grabBaseX: number;
  grabBaseY: number;
  moved: boolean;
}

/**
 * 牌桌场景：只负责「把模拟层状态画出来」和「把玩家操作翻译成动作」。
 * 所有规则判断都走 SpiderGame，场景本身不保存游戏状态。
 */
export class GameScene extends Phaser.Scene {
  private spider?: SpiderGame;
  private layout!: BoardLayout;

  private cardSprites = new Map<number, Phaser.GameObjects.Image>();
  private locations = new Map<number, CardLocation>();
  private columnSlots: Phaser.GameObjects.Image[] = [];
  private foundationSlots: Phaser.GameObjects.Image[] = [];
  private badges: Phaser.GameObjects.Image[] = [];
  private stockBacks: Phaser.GameObjects.Image[] = [];
  private columnZones: Phaser.GameObjects.Zone[] = [];
  private stockZone!: Phaser.GameObjects.Zone;
  private highlight!: Phaser.GameObjects.Image;
  private targetGlow!: Phaser.GameObjects.Image;

  private dragState: DragState | null = null;
  private selected: { col: number; index: number; id: number } | null = null;
  private exiting = new Set<number>();
  private busy = false;
  private blocked = false;
  private ready = false;
  /**
   * 拖拽期间的 pointerup 不应该再被当成一次点击，
   * 否则落点位置的牌会被选中，留下一个突兀的金色高亮。
   */
  private dragging = false;
  private clickSuppressedUntil = 0;
  private hintGlowTimer: Phaser.Time.TimerEvent | null = null;
  private lastClick = { id: -1, at: 0 };
  /** 手机上少撒点粒子，省电也更跟手 */
  private lowPower = false;

  constructor() {
    super('Game');
  }

  /** 应用层注入 / 替换当前对局 */
  attachGame(game: SpiderGame): void {
    this.spider = game;
    if (!this.ready) return;
    this.clearSelection();
    this.applyLayout();
    this.syncBoard({ instant: true });
  }

  create(): void {
    this.lowPower = window.matchMedia('(max-width: 900px)').matches;
    this.buildStaticObjects();
    this.bindInput();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
    });
    this.applyLayout();
    if (this.spider) this.syncBoard({ instant: true });
    this.ready = true;
    bus.emit('scene:ready', undefined);
  }

  override update(_time: number, delta: number): void {
    if (!this.spider || this.blocked) return;
    this.spider.tick(delta);
  }

  /** 覆盖层打开时冻结计时 */
  setBlocked(value: boolean): void {
    this.blocked = value;
  }

  // ------------------------------------------------------------------ 对外操作

  requestDeal(): void {
    if (!this.spider || this.busy || this.blocked) return;
    const outcome = this.spider.deal();
    if (!outcome.ok) {
      playSfx(outcome.reason === 'empty-column' ? 'dealBlocked' : 'invalid');
      haptic('invalid');
      bus.emit('toast', {
        text: outcome.reason === 'empty-column' ? '有空列时不能发牌，先把空列填满' : '发牌堆已经空了',
        tone: 'warn',
      });
      return;
    }
    playSfx('deal');
    const newIds = this.spider.state.columns.flat().map((c) => c.id);
    this.applyLayout();
    this.syncBoard({ dealIds: newIds });
    this.afterStateChange(outcome.completed, outcome.completedIds);
  }

  requestUndo(): void {
    if (!this.spider || this.busy || this.blocked) return;
    if (!this.spider.undo()) {
      playSfx('invalid');
      haptic('invalid');
      bus.emit('toast', { text: '没有可以撤销的操作了', tone: 'warn' });
      return;
    }
    playSfx('undo');
    this.clearSelection();
    this.applyLayout();
    this.syncBoard({ instant: false });
    this.afterStateChange();
  }

  requestHint(): void {
    if (!this.spider || this.busy || this.blocked) return;
    const hint = this.spider.hint();
    if (!hint) {
      playSfx('invalid');
      bus.emit('toast', {
        text: this.spider.remainingDeals > 0 ? '桌面暂时没有好走法，试试发一轮牌' : '暂时没有可走的牌了',
        tone: 'warn',
      });
      return;
    }
    const card = this.spider.state.columns[hint.from][hint.index];
    const sprite = this.cardSprites.get(card.id);
    if (sprite) {
      this.showHighlightAt(sprite.x, sprite.y);
      this.pulseHint(sprite);
    }
    const targetColumn = this.spider.state.columns[hint.to];
    const top = targetColumn[targetColumn.length - 1];
    const targetSprite = top ? this.cardSprites.get(top.id) : undefined;
    this.showTargetGlow(
      targetSprite ? targetSprite.x : this.layout.columnX[hint.to],
      targetSprite ? targetSprite.y : this.layout.columnTopY,
    );
    // 提示光效只停留一会儿，避免一直挂在牌桌上
    this.hintGlowTimer?.remove();
    this.hintGlowTimer = this.time.delayedCall(2600, () => {
      this.targetGlow.setVisible(false);
      this.highlight.setVisible(false);
    });
    playSfx('select');
    bus.emit('toast', { text: '提示：高亮的牌可以移动到发光的位置', tone: 'info' });
  }

  clearSelection(): void {
    this.selected = null;
    if (this.highlight) this.highlight.setVisible(false);
    if (this.targetGlow) this.targetGlow.setVisible(false);
  }

  // ------------------------------------------------------------------ 静态物件

  private buildStaticObjects(): void {
    for (let i = 0; i < 10; i += 1) {
      const slot = this.add.image(0, 0, TEX.slot).setOrigin(0, 0).setDepth(DEPTH.slot);
      this.columnSlots.push(slot);
      const zone = this.add.zone(0, 0, 10, 10).setOrigin(0, 0);
      zone.setData('kind', 'column');
      zone.setData('col', i);
      this.columnZones.push(zone);
    }

    for (let i = 0; i < 8; i += 1) {
      this.foundationSlots.push(
        this.add.image(0, 0, TEX.foundation).setOrigin(0, 0).setDepth(DEPTH.slot).setAlpha(0.55),
      );
      // 收牌位显示该花色的 K（用真实牌面），比画一个符号更直观
      const badge = this.add
        .image(0, 0, TEX.card('S', 13))
        .setOrigin(CARD_ORIGIN_X, CARD_ORIGIN_Y)
        .setDepth(DEPTH.stockBack);
      badge.setVisible(false);
      this.badges.push(badge);
    }

    for (let i = 0; i < 5; i += 1) {
      this.stockBacks.push(
        this.add.image(0, 0, TEX.back).setOrigin(0, 0).setDepth(DEPTH.stockBack + i).setVisible(false),
      );
    }

    this.stockZone = this.add.zone(0, 0, 10, 10).setOrigin(0, 0);
    this.stockZone.setData('kind', 'stock');

    this.highlight = this.add
      .image(0, 0, TEX.highlight)
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH.highlight)
      .setVisible(false);
    this.targetGlow = this.add
      .image(0, 0, TEX.glow)
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH.slot + 2)
      .setVisible(false);
  }

  /**
   * Phaser 的 hitArea 是固定尺寸的矩形，不会跟着对象缩放。
   * 这里直接改写同一个矩形实例：既保持精度，又避免反复 removeInteractive/setInteractive
   * 在延迟队列里互相抵消导致命中区失效。
   */
  private placeZone(
    zone: Phaser.GameObjects.Zone,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    zone.setPosition(x, y);
    zone.setSize(w, h);
    if (!zone.input) {
      zone.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains);
      return;
    }
    const area = zone.input.hitArea as Phaser.Geom.Rectangle;
    if (area && typeof area.setTo === 'function') area.setTo(0, 0, w, h);
  }

  private applyLayout(): void {
    const columns = this.spider ? this.spider.state.columns : [];
    this.layout = computeLayout(this.scale.width, this.scale.height, columns);
    const { cardW, cardH } = this.layout;
    const columnHeight = Math.max(90, this.layout.tableauBottom - this.layout.columnTopY + 16);

    this.columnSlots.forEach((slot, i) => {
      slot.setPosition(this.layout.columnX[i] - cardW / 2, this.layout.columnTopY);
      slot.setDisplaySize(cardW, cardH);
      this.placeZone(
        this.columnZones[i],
        this.layout.columnX[i] - cardW / 2,
        this.layout.columnTopY - 8,
        cardW,
        columnHeight,
      );
    });

    this.foundationSlots.forEach((slot, i) => {
      const rect = this.layout.foundations[i];
      slot.setPosition(rect.x, rect.y);
      slot.setDisplaySize(rect.w, rect.h);
    });

    this.badges.forEach((badge, i) => {
      const rect = this.layout.foundations[i];
      badge.setPosition(rect.x + rect.w / 2, rect.y + rect.h / 2);
      if (badge.visible) badge.setDisplaySize(rect.w * CELL_SCALE_X, rect.h * CELL_SCALE_Y);
    });

    const stock = this.layout.stock;
    this.stockBacks.forEach((back, i) => {
      back.setPosition(stock.x + i * 1.6, stock.y - i * 1.6);
      back.setDisplaySize(stock.w, stock.h);
    });
    this.placeZone(this.stockZone, stock.x, stock.y, stock.w, stock.h);

    this.highlight.setDisplaySize(cardW * CELL_SCALE_X * 1.02, cardH * CELL_SCALE_Y * 1.02);
    this.targetGlow.setDisplaySize(cardW * 1.9, cardH * 1.6);
  }

  /** 纹理是「含投影余量的整格」，所以显示尺寸要换算一下，牌面才正好是布局算出来的大小 */
  private sizeCardSprite(sprite: Phaser.GameObjects.Image): void {
    sprite.setDisplaySize(this.layout.cardW * CELL_SCALE_X, this.layout.cardH * CELL_SCALE_Y);
  }

  private onResize(): void {
    this.applyLayout();
    if (this.spider) this.syncBoard({ instant: true });
  }

  // ------------------------------------------------------------------ 状态同步

  private cardOffsetY(column: Card[], index: number): number {
    let y = 0;
    for (let i = 0; i < index; i += 1) {
      y += column[i].faceUp ? this.layout.fanUp : this.layout.fanDown;
    }
    return y;
  }

  /** 把模拟层状态投影到视图 */
  private syncBoard(options: { instant?: boolean; dealIds?: number[] } = {}): void {
    if (!this.spider) return;
    const { instant = false, dealIds } = options;
    const dealt = new Set(dealIds ?? []);
    const state = this.spider.state;
    this.locations.clear();
    const alive = new Set<number>();

    state.columns.forEach((column, col) => {
      column.forEach((card, index) => {
        alive.add(card.id);
        this.locations.set(card.id, { col, index });
        const x = this.layout.columnX[col];
        // 卡牌以中心为原点，所以要把「顶边 y」加上半张牌高
        const y =
          this.layout.columnTopY + this.cardOffsetY(column, index) + this.layout.cardH / 2;
        const depth = DEPTH.card + col * 220 + index;
        let sprite = this.cardSprites.get(card.id);

        if (!sprite) {
          sprite = this.createCardSprite(card);
          this.cardSprites.set(card.id, sprite);
          if (dealt.has(card.id) && !instant) {
            const stock = this.layout.stock;
            sprite.setPosition(stock.x + stock.w / 2, stock.y + stock.h / 2);
            this.tweens.add({
              targets: sprite,
              x,
              y,
              duration: 280,
              delay: index * 24,
              ease: 'Cubic.easeOut',
            });
          } else {
            sprite.setPosition(x, y);
          }
        } else if (instant) {
          this.tweens.killTweensOf(sprite);
          sprite.setPosition(x, y);
        } else {
          this.tweens.killTweensOf(sprite);
          this.tweens.add({ targets: sprite, x, y, duration: MOVE_MS, ease: 'Cubic.easeOut' });
        }

        sprite.setDepth(depth);
        this.sizeCardSprite(sprite);
        this.applyFace(sprite, card, instant);
      });
    });

    for (const [id, sprite] of [...this.cardSprites.entries()]) {
      if (alive.has(id) || this.exiting.has(id)) continue;
      this.cardSprites.delete(id);
      sprite.destroy();
    }

    this.badges.forEach((badge, i) => {
      const suit = state.sets[i];
      if (!suit) {
        badge.setVisible(false);
        return;
      }
      if (badge.getData('suit') !== suit) {
        badge.setTexture(TEX.card(suit, 13));
        badge.setData('suit', suit);
        if (!instant) this.popBadge(i);
      }
      badge.setVisible(true);
    });

    this.stockBacks.forEach((back, i) => {
      back.setVisible(i < state.stock.length);
    });

    if (this.selected) {
      if (!this.locations.has(this.selected.id)) this.clearSelection();
      else this.positionHighlight();
    }
  }

  private createCardSprite(card: Card): Phaser.GameObjects.Image {
    const key = card.faceUp ? TEX.card(card.suit, card.rank) : TEX.back;
    const sprite = this.add
      .image(0, 0, key)
      .setOrigin(CARD_ORIGIN_X, CARD_ORIGIN_Y)
      .setDepth(DEPTH.card);
    sprite.setData('cardId', card.id);
    sprite.setData('faceUp', card.faceUp);
    sprite.setInteractive({ draggable: true, useHandCursor: true });
    sprite.on(Phaser.Input.Events.GAMEOBJECT_DRAG_START, (pointer: Phaser.Input.Pointer) =>
      this.onDragStart(pointer, sprite),
    );
    sprite.on(
      Phaser.Input.Events.GAMEOBJECT_DRAG,
      (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => this.onDragMove(dragX, dragY),
    );
    sprite.on(Phaser.Input.Events.GAMEOBJECT_DRAG_END, () => this.onDragEnd());
    return sprite;
  }

  private applyFace(sprite: Phaser.GameObjects.Image, card: Card, instant: boolean): void {
    const key = card.faceUp ? TEX.card(card.suit, card.rank) : TEX.back;
    const wasFaceUp = sprite.getData('faceUp') as boolean;
    if (wasFaceUp === card.faceUp) {
      if (sprite.texture.key !== key) sprite.setTexture(key);
      return;
    }
    sprite.setData('faceUp', card.faceUp);
    if (instant) {
      sprite.setTexture(key);
      return;
    }
    const targetScaleX = sprite.scaleX;
    this.tweens.add({
      targets: sprite,
      scaleX: 0.08,
      duration: 90,
      ease: 'Sine.easeIn',
      onComplete: () => {
        sprite.setTexture(key);
        this.tweens.add({
          targets: sprite,
          scaleX: targetScaleX,
          duration: 110,
          ease: 'Sine.easeOut',
        });
      },
    });
  }

  private popBadge(index: number): void {
    const badge = this.badges[index];
    const rect = this.layout.foundations[index];
    if (!badge || !rect) return;
    badge.setAlpha(0);
    badge.setDisplaySize(rect.w * CELL_SCALE_X * 1.6, rect.h * CELL_SCALE_Y * 1.6);
    this.tweens.add({
      targets: badge,
      displayWidth: rect.w * CELL_SCALE_X,
      displayHeight: rect.h * CELL_SCALE_Y,
      alpha: 1,
      duration: 380,
      ease: 'Back.easeOut',
    });
  }

  // ------------------------------------------------------------------ 输入

  private bindInput(): void {
    this.input.dragDistanceThreshold = 7;

    this.input.on(
      Phaser.Input.Events.GAMEOBJECT_UP,
      (pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
        if (!obj || typeof obj.getData !== 'function') return;
        // 拖拽结束的那次抬手不算点击，否则会顺手选中落点位置的牌
        if (this.dragging || this.time.now < this.clickSuppressedUntil) return;
        const kind = obj.getData('kind') as string | undefined;
        if (kind === 'stock') {
          this.requestDeal();
          return;
        }
        if (kind === 'column') {
          this.onColumnClick(obj.getData('col') as number);
          return;
        }
        if (obj.getData('cardId') !== undefined) {
          this.onCardClick(obj as Phaser.GameObjects.Image, pointer);
        }
      },
    );

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      if (!this.selected) return;
      const hits = this.input.hitTestPointer(pointer);
      if (hits.length === 0) this.clearSelection();
    });

    // 在画布外松手时 Phaser 不会派发 DRAG_END，这里主动收尾，避免残留落点光效
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, () => {
      if (this.dragState) this.onDragEnd();
    });
  }

  private onDragStart(_pointer: Phaser.Input.Pointer, sprite: Phaser.GameObjects.Image): void {
    if (!this.spider || this.busy || this.blocked) return;
    const id = sprite.getData('cardId') as number;
    const loc = this.locations.get(id);
    if (!loc || !canPickUp(this.spider.state, loc.col, loc.index)) {
      this.dragState = null;
      this.nudge(sprite);
      return;
    }
    const column = this.spider.state.columns[loc.col];
    const ids = column.slice(loc.index).map((c) => c.id);
    const base = ids.map((cardId) => {
      const s = this.cardSprites.get(cardId);
      return { x: s?.x ?? 0, y: s?.y ?? 0 };
    });
    this.dragState = {
      from: loc.col,
      index: loc.index,
      ids,
      base,
      grabBaseX: sprite.x,
      grabBaseY: sprite.y,
      moved: false,
    };
    ids.forEach((cardId, i) => this.cardSprites.get(cardId)?.setDepth(DEPTH.dragging + i));
    if (this.selected) this.clearSelection();
    this.dragging = true;
    this.targetGlow.setVisible(false);
    playSfx('select');
  }

  private onDragMove(dragX: number, dragY: number): void {
    const drag = this.dragState;
    if (!drag || !this.spider) return;
    const dx = dragX - drag.grabBaseX;
    const dy = dragY - drag.grabBaseY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

    drag.ids.forEach((cardId, i) => {
      const sprite = this.cardSprites.get(cardId);
      if (!sprite) return;
      sprite.setPosition(drag.base[i].x + dx, drag.base[i].y + dy);
      sprite.setRotation(Phaser.Math.Clamp(dx * 0.008, -0.05, 0.05));
    });

    const target = this.columnAt();
    if (target === null) {
      this.targetGlow.setVisible(false);
      return;
    }
    const valid = target !== drag.from && this.spider.canMove(drag.from, drag.index, target);
    const column = this.spider.state.columns[target];
    const y =
      column.length > 0
        ? this.layout.columnTopY + this.cardOffsetY(column, column.length - 1)
        : this.layout.columnTopY;
    this.showTargetGlow(this.layout.columnX[target], y, valid);
  }

  private onDragEnd(): void {
    const drag = this.dragState;
    this.targetGlow.setVisible(false);
    this.dragging = false;
    this.clickSuppressedUntil = this.time.now + 260;
    if (!drag || !this.spider) return;
    this.dragState = null;
    drag.ids.forEach((id) => this.cardSprites.get(id)?.setRotation(0));

    if (!drag.moved) {
      this.syncBoard({ instant: false });
      return;
    }
    const target = this.columnAt();
    if (target !== null && target !== drag.from) {
      if (this.spider.canMove(drag.from, drag.index, target)) {
        this.performMove(drag.from, drag.index, target);
        return;
      }
      playSfx('invalid');
      haptic('invalid');
      this.flashColumn(target);
    }
    this.syncBoard({ instant: false });
  }

  private onCardClick(sprite: Phaser.GameObjects.Image, _pointer: Phaser.Input.Pointer): void {
    if (!this.spider || this.busy || this.blocked) return;
    const id = sprite.getData('cardId') as number;
    const loc = this.locations.get(id);
    if (!loc) return;

    const now = this.time.now;
    if (this.lastClick.id === id && now - this.lastClick.at < CLICK_WINDOW_MS) {
      this.lastClick = { id: -1, at: 0 };
      const outcome = this.spider.autoMove(loc.col, loc.index);
      if (outcome.ok && outcome.to !== undefined) {
        this.performMoveApplied(outcome.to, outcome);
      } else {
        playSfx('invalid');
        haptic('invalid');
        this.nudge(sprite);
      }
      return;
    }
    this.lastClick = { id, at: now };

    if (this.selected) {
      if (this.selected.id === id) {
        this.clearSelection();
        playSfx('deselect');
        return;
      }
      if (
        this.selected.col !== loc.col &&
        this.spider.canMove(this.selected.col, this.selected.index, loc.col)
      ) {
        const { col, index } = this.selected;
        this.clearSelection();
        this.performMove(col, index, loc.col);
        return;
      }
    }

    if (canPickUp(this.spider.state, loc.col, loc.index)) {
      this.selected = { col: loc.col, index: loc.index, id };
      this.positionHighlight();
      playSfx('select');
      return;
    }
    playSfx('invalid');
    haptic('invalid');
    this.nudge(sprite);
  }

  private onColumnClick(col: number): void {
    if (!this.spider || this.busy || this.blocked || !this.selected) return;
    const { col: from, index } = this.selected;
    if (from === col) {
      this.clearSelection();
      return;
    }
    if (this.spider.canMove(from, index, col)) {
      this.clearSelection();
      this.performMove(from, index, col);
      return;
    }
    playSfx('invalid');
    haptic('invalid');
    this.flashColumn(col);
  }

  // ------------------------------------------------------------------ 动作

  private performMove(from: number, index: number, to: number): void {
    if (!this.spider) return;
    const outcome = this.spider.move(from, index, to);
    if (!outcome.ok) {
      playSfx('invalid');
      haptic('invalid');
      this.syncBoard({ instant: false });
      return;
    }
    this.performMoveApplied(to, outcome);
  }

  private performMoveApplied(to: number, outcome: ReturnType<SpiderGame['move']>): void {
    if (!this.spider) return;
    if (outcome.flipped) playSfx('flip');
    playSfx('place');
    haptic('drop');
    this.clearSelection();
    this.afterStateChange(outcome.completed, outcome.completedIds);

    const column = this.spider.state.columns[to];
    const top = column[column.length - 1];
    if (top) {
      this.time.delayedCall(MOVE_MS, () => {
        const sprite = this.cardSprites.get(top.id);
        if (sprite) this.impact(sprite);
      });
    }
  }

  private afterStateChange(completed?: Suit[], completedIds?: number[]): void {
    if (!this.spider) return;
    if (completed && completed.length > 0 && completedIds && completedIds.length > 0) {
      this.celebrate(completed, completedIds);
    } else {
      this.syncBoard({ instant: false });
    }
    bus.emit('state:changed', { state: this.spider.state });
    if (this.spider.isWon) this.winSequence();
  }

  /** 收牌动画：13 张牌依次飞向收牌位，同时撒金粉 */
  private celebrate(suits: Suit[], ids: number[]): void {
    if (!this.spider) return;
    this.busy = true;
    const firstIndex = Math.max(0, this.spider.state.sets.length - suits.length);
    const rect = this.layout.foundations[firstIndex];
    ids.forEach((id) => this.exiting.add(id));

    ids.forEach((id, i) => {
      const sprite = this.cardSprites.get(id);
      if (!sprite) return;
      const px = sprite.x;
      const py = sprite.y;
      this.tweens.add({
        targets: sprite,
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        displayWidth: rect.w * CELL_SCALE_X,
        displayHeight: rect.h * CELL_SCALE_Y,
        alpha: 0.12,
        rotation: Phaser.Math.FloatBetween(-0.3, 0.3),
        duration: 520,
        delay: i * 26,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          sprite.destroy();
          this.cardSprites.delete(id);
          this.exiting.delete(id);
        },
      });
      this.time.delayedCall(i * 26, () => this.burst(px, py, 3));
    });

    playSfx('complete');
    haptic('complete');
    suits.forEach((suit, i) => {
      bus.emit('sets:completed', { suit, total: firstIndex + i + 1 });
    });
    this.floatText(rect.x + rect.w / 2, rect.y + rect.h + 34, '+100', '#ffe6a6');
    this.time.delayedCall(120, () => this.burst(rect.x + rect.w / 2, rect.y + rect.h / 2, 28));

    this.time.delayedCall(760, () => {
      this.busy = false;
      this.syncBoard({ instant: false });
    });
  }

  private winSequence(): void {
    playSfx('win');
    haptic('win');
    if (this.spider) bus.emit('game:won', { state: this.spider.state });
    const cx = this.layout.width / 2;
    const cy = this.layout.columnTopY + this.layout.cardH;
    const spread = Math.round(this.layout.width * 0.3);
    for (let i = 0; i < 6; i += 1) {
      this.time.delayedCall(i * 140, () => {
        this.burst(
          cx + Phaser.Math.Between(-spread, spread),
          cy + Phaser.Math.Between(-90, 90),
          22,
        );
      });
    }
  }

  // ------------------------------------------------------------------ 特效

  private positionHighlight(): void {
    if (!this.selected) return;
    const sprite = this.cardSprites.get(this.selected.id);
    if (!sprite) return;
    this.highlight.setPosition(sprite.x, sprite.y);
    this.highlight.setDepth(sprite.depth + 1);
    this.highlight.setDisplaySize(
      this.layout.cardW * CELL_SCALE_X * 1.03,
      this.layout.cardH * CELL_SCALE_Y * 1.03,
    );
    this.highlight.setVisible(true).setAlpha(0.95);
  }

  private showHighlightAt(x: number, y: number): void {
    this.highlight.setPosition(x, y);
    this.highlight.setDepth(DEPTH.highlight);
    this.highlight.setDisplaySize(
      this.layout.cardW * CELL_SCALE_X * 1.03,
      this.layout.cardH * CELL_SCALE_Y * 1.03,
    );
    this.highlight.setVisible(true);
    this.tweens.killTweensOf(this.highlight);
    this.tweens.add({
      targets: this.highlight,
      alpha: { from: 1, to: 0.35 },
      duration: 420,
      yoyo: true,
      repeat: 3,
      onComplete: () => this.highlight.setVisible(false),
    });
  }

  private showTargetGlow(x: number, y: number, valid = true): void {
    this.targetGlow.setPosition(x, y);
    this.targetGlow.setVisible(true);
    this.targetGlow.setAlpha(valid ? 0.9 : 0.45);
    this.targetGlow.setTint(valid ? 0xffe9b0 : 0xff9a8a);
  }

  private pulseHint(sprite: Phaser.GameObjects.Image): void {
    this.tweens.add({
      targets: sprite,
      angle: 2.5,
      duration: 110,
      yoyo: true,
      repeat: 4,
      onComplete: () => sprite.setAngle(0),
    });
  }

  private nudge(sprite: Phaser.GameObjects.Image): void {
    const baseX = sprite.x;
    this.tweens.killTweensOf(sprite);
    this.tweens.add({
      targets: sprite,
      x: baseX + 7,
      duration: 55,
      yoyo: true,
      repeat: 1,
      onComplete: () => sprite.setX(baseX),
    });
  }

  private impact(sprite: Phaser.GameObjects.Image): void {
    if (!sprite.active) return;
    this.tweens.killTweensOf(sprite);
    sprite.setDisplaySize(
      this.layout.cardW * CELL_SCALE_X * 1.06,
      this.layout.cardH * CELL_SCALE_Y * 0.94,
    );
    this.tweens.add({
      targets: sprite,
      displayWidth: this.layout.cardW * CELL_SCALE_X,
      displayHeight: this.layout.cardH * CELL_SCALE_Y,
      duration: 160,
      ease: 'Back.easeOut',
    });
  }

  private flashColumn(col: number): void {
    const zone = this.columnZones[col];
    if (!zone) return;
    const flash = this.add
      .rectangle(zone.x, zone.y, zone.width, zone.height, 0xff6b5a, 0.22)
      .setOrigin(0, 0)
      .setDepth(DEPTH.fx);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 300,
      onComplete: () => flash.destroy(),
    });
  }

  private burst(x: number, y: number, count: number): void {
    const emitter = this.add.particles(x, y, TEX.spark, {
      speed: { min: 60, max: 280 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 320, max: 760 },
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(DEPTH.fx);
    emitter.explode(this.lowPower ? Math.max(4, Math.round(count * 0.55)) : count);
    this.time.delayedCall(900, () => emitter.destroy());
  }

  private floatText(x: number, y: number, text: string, color: string): void {
    const label = this.add
      .text(x, y, text, {
        fontFamily: UI_FONT,
        fontSize: '30px',
        color,
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.label)
      .setShadow(0, 3, 'rgba(0,0,0,0.55)', 6);
    this.tweens.add({
      targets: label,
      y: y - 70,
      alpha: 0,
      duration: 900,
      ease: 'Cubic.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  /** 指针横向最近的一列，超出容差返回 null */
  private columnAt(): number | null {
    const pointer = this.input.activePointer;
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    this.layout.columnX.forEach((cx, index) => {
      const distance = Math.abs(pointer.x - cx);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best === null) return null;
    return bestDistance <= this.layout.cardW * 0.9 ? best : null;
  }
}
