import Phaser from 'phaser';
import { audioBus } from './audio/audioBus';
import { music } from './audio/music';
import { playSfx } from './audio/sfx';
import { bus } from './core/bus';
import { haptic, setHapticsEnabled } from './core/haptics';
import { SpiderGame } from './game/simulation/game';
import type { SuitCount } from './game/simulation/types';
import { bindKeys } from './input/bindings';
import * as storage from './persist/storage';
import { BootScene } from './phaser/scenes/BootScene';
import { GameScene } from './phaser/scenes/GameScene';
import { Hud } from './ui/hud';
import {
  Overlays,
  openHelpPanel,
  openMenuPanel,
  openStartPanel,
  openWinPanel,
  showToast,
} from './ui/overlays';

function query<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`缺少必要的容器节点：${selector}`);
  return node;
}

/** 组装整个游戏：音频、DOM UI、Phaser 场景、存档与快捷键 */
export function createApp(root: HTMLElement): void {
  const hudRoot = query(root, '#hud-root');
  const dockRoot = query(root, '#dock-root');
  const stage = query(root, '#stage');
  const overlayLayer = query(root, '#overlay-layer');
  const toastLayer = query(root, '#toast-layer');
  const splash = root.querySelector<HTMLElement>('#boot-splash');
  const splashBar = root.querySelector<HTMLElement>('#boot-bar');
  const splashHint = root.querySelector<HTMLElement>('#boot-hint');
  const splashRetry = root.querySelector<HTMLButtonElement>('#boot-retry');

  const settings = storage.loadSettings();
  let sfxOn = settings.sfx;
  let musicOn = settings.music;
  let hapticsOn = settings.haptics;
  let suitCount: SuitCount = settings.suitCount;

  audioBus.setSfxEnabled(sfxOn);
  audioBus.setMusicEnabled(musicOn);
  setHapticsEnabled(hapticsOn);

  const savedRaw = storage.loadGame();
  const saved = savedRaw ? SpiderGame.deserialize(savedRaw) : null;
  let resumable = saved !== null && saved.state.status === 'playing';
  if (!resumable) storage.clearGame();
  let current = resumable && saved ? saved : SpiderGame.newGame(suitCount);

  /** 顶栏/底栏需要的一小撮派生信息 */
  const hudFlags = (): { canUndo: boolean; canDeal: boolean; dealsLeft: number } => ({
    canUndo: current.canUndo,
    canDeal: current.remainingDeals > 0,
    dealsLeft: current.remainingDeals,
  });

  const scene = new GameScene();

  // ---------------------------------------------------------------- 声音开关
  const persistSettings = (): void => {
    settings.sfx = sfxOn;
    settings.music = musicOn;
    settings.haptics = hapticsOn;
    settings.suitCount = suitCount;
    storage.saveSettings(settings);
  };

  const applyAudio = (): void => {
    audioBus.setSfxEnabled(sfxOn);
    audioBus.setMusicEnabled(musicOn);
    if (musicOn) {
      if (audioBus.ready && !music.playing) music.start();
    } else if (music.playing) {
      music.stop();
    }
    hud.setSound(sfxOn || musicOn);
    persistSettings();
  };

  const unlockAudio = (): void => {
    void audioBus.unlock().then(() => {
      audioBus.setMusicEnabled(musicOn);
      if (musicOn && !music.playing) music.start();
    });
  };

  // ---------------------------------------------------------------- 覆盖层
  const overlays = new Overlays(overlayLayer, (open) => {
    scene.setBlocked(open);
    if (audioBus.ready) audioBus.fadeMusic(open ? 0.35 : 1, 0.4);
  });

  const openStart = (): void => {
    openStartPanel(overlays, {
      hasSave: resumable,
      suitCount,
      bestFor: (count) => storage.bestFor(count),
      sfx: sfxOn,
      music: musicOn,
      haptics: hapticsOn,
      onStart: (kind, count) => {
        suitCount = count;
        if (kind === 'continue' && resumable) {
          const raw = storage.loadGame();
          const restored = raw ? SpiderGame.deserialize(raw) : null;
          if (restored) {
            current = restored;
            attachCurrent();
            overlays.closeAll();
            showToast(toastLayer, '已恢复上一局的进度', 'good');
            return;
          }
        }
        startNewGame(count);
      },
      onToggleSfx: (value) => {
        sfxOn = value;
        applyAudio();
      },
      onToggleMusic: (value) => {
        musicOn = value;
        applyAudio();
      },
      onToggleHaptics: (value) => {
        hapticsOn = value;
        setHapticsEnabled(value);
        persistSettings();
        if (value) haptic('tap');
      },
      onHelp: () => openHelpPanel(overlays),
    });
  };

  const openMenu = (): void => {
    openMenuPanel(overlays, {
      sfx: sfxOn,
      music: musicOn,
      haptics: hapticsOn,
      elapsedMs: current.state.elapsedMs,
      onResume: () => overlays.closeTop(),
      onNewGame: () => {
        overlays.closeAll();
        startNewGame(suitCount);
      },
      onHelp: () => openHelpPanel(overlays),
      onToggleSfx: (value) => {
        sfxOn = value;
        applyAudio();
      },
      onToggleMusic: (value) => {
        musicOn = value;
        applyAudio();
      },
      onToggleHaptics: (value) => {
        hapticsOn = value;
        setHapticsEnabled(value);
        persistSettings();
      },
    });
  };

  // ---------------------------------------------------------------- 对局管理
  const attachCurrent = (): void => {
    scene.attachGame(current);
    hud.update(current.state, hudFlags());
    storage.saveGame(current.serialize());
  };

  const startNewGame = (count: SuitCount, seed?: number): void => {
    suitCount = count;
    current = SpiderGame.newGame(count, seed);
    resumable = true;
    persistSettings();
    attachCurrent();
    overlays.closeAll();
    showToast(toastLayer, `新的一局开始了 · ${count} 花色`, 'info');
    maybeHintPortrait();
  };

  /** 窄竖屏第一次进入时，轻声提一句横屏更舒服（只提醒一次） */
  const maybeHintPortrait = (): void => {
    if (window.innerWidth > 520 || window.innerHeight < window.innerWidth) return;
    if (storage.hasFlag('portrait-hint')) return;
    storage.setFlag('portrait-hint');
    window.setTimeout(() => showToast(toastLayer, '小提示：横屏玩蜘蛛纸牌视野更宽', 'info'), 900);
  };

  const toggleMasterSound = (): void => {
    playSfx('click');
    const anyOn = sfxOn || musicOn;
    sfxOn = !anyOn;
    musicOn = !anyOn;
    applyAudio();
  };

  // ---------------------------------------------------------------- DOM UI
  const hud = new Hud(
    hudRoot,
    dockRoot,
    {
      onDeal: () => scene.requestDeal(),
      onUndo: () => scene.requestUndo(),
      onHint: () => scene.requestHint(),
      onToggleSound: () => toggleMasterSound(),
      onMenu: () => openMenu(),
    },
    () => current.state.elapsedMs,
  );
  hud.setSound(sfxOn || musicOn);

  // ---------------------------------------------------------------- 事件订阅
  bus.on('state:changed', ({ state }) => {
    hud.update(state, hudFlags());
    if (state.status === 'playing') storage.saveGame(JSON.stringify(state));
  });

  bus.on('toast', ({ text, tone }) => showToast(toastLayer, text, tone ?? 'info'));

  bus.on('sets:completed', ({ suit, total }) => {
    if (total < 8) showToast(toastLayer, `收下第 ${total} 组同花顺 ${suit === 'S' ? '♠' : '♥'}`, 'good');
  });

  bus.on('game:won', ({ state }) => {
    resumable = false;
    storage.clearGame();
    const isRecord = storage.recordBest(state.suitCount, state.score);
    window.setTimeout(() => {
      openWinPanel(overlays, {
        state,
        best: storage.bestFor(state.suitCount),
        isRecord,
        onPlayAgain: () => {
          overlays.closeAll();
          startNewGame(state.suitCount);
        },
        onChangeDifficulty: () => {
          overlays.closeAll();
          openStart();
        },
      });
    }, 1500);
  });

  let startPanelOpened = false;
  const openStartOnce = (): void => {
    if (startPanelOpened) return;
    startPanelOpened = true;
    openStart();
  };
  bus.on('scene:ready', openStartOnce);

  // ---------------------------------------------------------------- 加载进度
  bus.on('load:progress', ({ value }) => {
    if (splashBar) splashBar.style.width = `${Math.round(Math.min(1, value) * 100)}%`;
  });

  bus.on('load:error', ({ url }) => {
    if (splashHint) splashHint.textContent = `牌面素材加载失败：${url}`;
    if (splashRetry) splashRetry.hidden = false;
  });

  bus.on('scene:ready', () => {
    if (splashBar) splashBar.style.width = '100%';
    splash?.classList.add('splash--hidden');
    window.setTimeout(() => splash?.remove(), 500);
  });

  splashRetry?.addEventListener('click', () => window.location.reload());

  /**
   * 调试桥：把关键对象挂到 window 上，方便手动排查与自动化脚本驱动。
   * 它不参与任何玩法逻辑，正常游戏不会用到。
   */
  (window as unknown as { __spider: unknown }).__spider = {
    get phaser() {
      return phaser;
    },
    get scene() {
      return scene;
    },
    state: () => current.state,
    game: () => current,
    audio: () => ({
      ready: audioBus.ready,
      state: audioBus.context?.state ?? 'none',
      sfx: audioBus.sfxEnabled,
      music: audioBus.musicEnabled,
      musicPlaying: music.playing,
    }),
    newGame: (count: SuitCount, seed?: number) => startNewGame(count, seed),
    load: (json: string) => {
      const restored = SpiderGame.deserialize(json);
      if (!restored) return false;
      current = restored;
      attachCurrent();
      overlays.closeAll();
      return true;
    },
    syncLayout: () => scene.attachGame(current),
  };

  // ---------------------------------------------------------------- Phaser
  /**
   * 画布必须按「设备像素」渲染，再用 CSS 缩回逻辑尺寸。
   * 否则在 DPR 2~3 的手机上，画布只有 1 倍分辨率却被浏览器放大 2~3 倍，整张牌桌都会发虚。
   */
  const PIXEL_RATIO_CAP = 3;
  const readRatio = (): number => Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP);
  const readStage = (): { w: number; h: number } => ({
    w: Math.max(1, stage.clientWidth),
    h: Math.max(1, stage.clientHeight),
  });

  let ratio = readRatio();
  const stageSize = readStage();

  const phaser = new Phaser.Game({
    type: Phaser.AUTO,
    parent: stage,
    transparent: true,
    banner: false,
    audio: { noAudio: true },
    scale: {
      mode: Phaser.Scale.NONE,
      width: Math.round(stageSize.w * ratio),
      height: Math.round(stageSize.h * ratio),
      zoom: 1 / ratio,
      autoRound: true,
    },
    render: {
      antialias: true,
      powerPreference: 'high-performance',
    },
    scene: [new BootScene(), scene],
  });

  /** NONE 模式下画布不会自己跟随父容器，尺寸变化时手动同步 */
  const syncViewport = (): void => {
    const nextRatio = readRatio();
    if (Math.abs(nextRatio - ratio) > 0.01) {
      ratio = nextRatio;
      phaser.scale.setZoom(1 / ratio);
    }
    const size = readStage();
    phaser.scale.resize(Math.round(size.w * ratio), Math.round(size.h * ratio));
  };
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', () => window.setTimeout(syncViewport, 150));
  window.visualViewport?.addEventListener('resize', syncViewport);

  scene.attachGame(current);
  hud.update(current.state, hudFlags());

  // Phaser 若被推迟到 DOMContentLoaded 之后启动，这里兜底
  window.setTimeout(openStartOnce, 60);

  // ---------------------------------------------------------------- 输入与生命周期
  bindKeys({
    onDeal: () => scene.requestDeal(),
    onUndo: () => scene.requestUndo(),
    onHint: () => scene.requestHint(),
    onNewGame: () => (overlays.isOpen ? overlays.closeTop() : openMenu()),
    onToggleSound: () => toggleMasterSound(),
    onMenu: () => openMenu(),
    onEscape: () => {
      if (overlays.isOpen) overlays.closeTop();
    },
  });

  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  document.addEventListener('visibilitychange', () => {
    audioBus.handleVisibility(document.hidden);
  });

  window.addEventListener('beforeunload', () => {
    if (current.state.status === 'playing') storage.saveGame(current.serialize());
  });

  void phaser;
}
