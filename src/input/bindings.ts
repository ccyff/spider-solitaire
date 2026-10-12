export interface KeyHandlers {
  onDeal(): void;
  onUndo(): void;
  onHint(): void;
  onNewGame(): void;
  onToggleSound(): void;
  onMenu(): void;
  onEscape(): void;
}

/** 键盘快捷键：空格/D 发牌、U 撤销、H 提示、N 新局、M 静音、Esc 返回 */
export function bindKeys(handlers: KeyHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.metaKey || event.altKey) return;

    const key = event.key.toLowerCase();

    if (event.ctrlKey) {
      if (key === 'z') {
        event.preventDefault();
        handlers.onUndo();
      }
      return;
    }

    switch (key) {
      case ' ':
      case 'd':
        event.preventDefault();
        handlers.onDeal();
        break;
      case 'u':
        handlers.onUndo();
        break;
      case 'h':
        handlers.onHint();
        break;
      case 'n':
        handlers.onNewGame();
        break;
      case 'm':
        handlers.onToggleSound();
        break;
      case 'escape':
        handlers.onEscape();
        break;
      default:
        break;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
