import type { GameState, Suit } from '../game/simulation/types';

export interface ToastPayload {
  text: string;
  tone?: 'info' | 'warn' | 'good';
}

export interface StateChangedPayload {
  state: GameState;
}

export interface Events {
  /** 场景准备就绪，UI 这时才能安全地派发指令 */
  'scene:ready': void;
  /** 资源加载进度（0..1） */
  'load:progress': { value: number };
  /** 资源加载完成 */
  'load:done': void;
  /** 资源加载失败 */
  'load:error': { url: string };
  /** 模拟层状态发生变化（移动 / 发牌 / 撤销 / 新局） */
  'state:changed': StateChangedPayload;
  /** 顶部临时提示 */
  'toast': ToastPayload;
  /** 完成一组同花顺 */
  'sets:completed': { suit: Suit; total: number };
  /** 通关 */
  'game:won': { state: GameState };
  /** 设置变更（音效 / 音乐 / 难度） */
  'settings:changed': { sfx: boolean; music: boolean };
}

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

/** 一个极小的类型安全事件总线：模拟层、场景、DOM UI 之间只通过它通信。 */
class EventBus {
  private handlers = new Map<keyof Events, Set<(payload: unknown) => void>>();

  on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[bus] ${String(event)} 处理出错`, error);
      }
    }
  }
}

export const bus = new EventBus();
