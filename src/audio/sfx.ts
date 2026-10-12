import { audioBus, type SfxName } from './audioBus';
import { noise, tone } from './synth';

/** 每张牌落点的轻微音高浮动，避免连发时听起来像机器 */
function jitter(amount: number): number {
  return (Math.random() * 2 - 1) * amount;
}

type Player = (dest: AudioNode, ctx: AudioContext) => void;

const players: Record<SfxName, Player> = {
  /** 界面按钮 */
  click: (dest, ctx) => {
    tone(ctx, dest, { type: 'square', freq: 1180, dur: 0.05, gain: 0.06, filterFreq: 3200 });
    noise(ctx, dest, { dur: 0.04, gain: 0.05, freqStart: 2600, q: 0.8 });
  },

  /** 拿起一张牌 */
  select: (dest, ctx) => {
    noise(ctx, dest, { dur: 0.07, gain: 0.1, freqStart: 1400, freqEnd: 2400, q: 1.2 });
    tone(ctx, dest, { type: 'triangle', freq: 660, dur: 0.07, gain: 0.07 });
  },

  /** 取消选择 */
  deselect: (dest, ctx) => {
    tone(ctx, dest, { type: 'triangle', freq: 520, freqEnd: 360, dur: 0.09, gain: 0.06 });
  },

  /** 翻牌 */
  flip: (dest, ctx) => {
    noise(ctx, dest, {
      dur: 0.11,
      gain: 0.16,
      freqStart: 900 + jitter(120),
      freqEnd: 2800,
      q: 1.1,
    });
    tone(ctx, dest, { type: 'square', freq: 1500, dur: 0.03, gain: 0.05 });
  },

  /** 落牌 */
  place: (dest, ctx) => {
    const base = 175 + jitter(14);
    tone(ctx, dest, {
      type: 'sine',
      freq: base,
      freqEnd: base * 0.5,
      dur: 0.13,
      gain: 0.22,
      filterFreq: 900,
    });
    noise(ctx, dest, { dur: 0.06, gain: 0.1, filterType: 'lowpass', freqStart: 900, q: 0.7 });
  },

  /** 非法操作 */
  invalid: (dest, ctx) => {
    tone(ctx, dest, { type: 'square', freq: 300, freqEnd: 230, dur: 0.09, gain: 0.1, filterFreq: 1400 });
    tone(ctx, dest, {
      type: 'square',
      freq: 288,
      freqEnd: 218,
      dur: 0.1,
      gain: 0.09,
      delay: 0.09,
      filterFreq: 1400,
    });
  },

  /** 发一轮牌：10 张依次落下 */
  deal: (dest, ctx) => {
    for (let i = 0; i < 10; i += 1) {
      const delay = i * 0.055;
      const base = 200 + jitter(24) - i * 3;
      tone(ctx, dest, {
        type: 'sine',
        freq: base,
        freqEnd: base * 0.55,
        dur: 0.1,
        gain: 0.14,
        delay,
        filterFreq: 1100,
        pan: (i - 4.5) / 9,
      });
      noise(ctx, dest, {
        dur: 0.05,
        gain: 0.07,
        filterType: 'highpass',
        freqStart: 1800,
        delay,
        pan: (i - 4.5) / 9,
      });
    }
  },

  /** 有空列时发牌被拒绝 */
  dealBlocked: (dest, ctx) => {
    tone(ctx, dest, { type: 'sawtooth', freq: 150, freqEnd: 120, dur: 0.22, gain: 0.1, filterFreq: 700 });
    tone(ctx, dest, { type: 'square', freq: 300, dur: 0.06, gain: 0.06, delay: 0.22 });
  },

  /** 收掉一组同花顺 */
  complete: (dest, ctx) => {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      tone(ctx, dest, {
        type: 'triangle',
        freq,
        dur: 0.42,
        gain: 0.15,
        delay: i * 0.085,
        filterFreq: 4200,
      });
      tone(ctx, dest, {
        type: 'sine',
        freq: freq * 2,
        dur: 0.3,
        gain: 0.05,
        delay: i * 0.085,
      });
    });
    noise(ctx, dest, { dur: 0.6, gain: 0.09, freqStart: 1600, freqEnd: 7000, q: 0.6, pan: 0.2 });
    tone(ctx, dest, { type: 'sine', freq: 130.81, dur: 0.7, gain: 0.12, delay: 0.34, filterFreq: 500 });
  },

  /** 通关 */
  win: (dest, ctx) => {
    const melody = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98, 2093];
    melody.forEach((freq, i) => {
      tone(ctx, dest, {
        type: 'triangle',
        freq,
        dur: 0.5,
        gain: 0.14,
        delay: i * 0.11,
        filterFreq: 5200,
        pan: (i - 3) / 6,
      });
    });
    // 收尾的大三和弦
    [1046.5, 1318.5, 1567.98, 2093].forEach((freq) => {
      tone(ctx, dest, { type: 'sine', freq, dur: 2.2, gain: 0.11, attack: 0.08, delay: 0.85 });
    });
    tone(ctx, dest, {
      type: 'sine',
      freq: 130.81,
      dur: 1.8,
      gain: 0.16,
      attack: 0.05,
      delay: 0.85,
      filterFreq: 600,
    });
    noise(ctx, dest, { dur: 1.6, gain: 0.08, freqStart: 3000, freqEnd: 11000, q: 0.5, delay: 0.85 });
    noise(ctx, dest, { dur: 0.9, gain: 0.12, filterType: 'lowpass', freqStart: 600, freqEnd: 90, delay: 0.85 });
  },

  /** 撤销：反向气声 */
  undo: (dest, ctx) => {
    noise(ctx, dest, {
      dur: 0.2,
      gain: 0.13,
      freqStart: 2600,
      freqEnd: 520,
      q: 0.9,
    });
    tone(ctx, dest, { type: 'triangle', freq: 480, freqEnd: 240, dur: 0.18, gain: 0.08 });
  },

  /** 洗牌 */
  shuffle: (dest, ctx) => {
    for (let i = 0; i < 14; i += 1) {
      noise(ctx, dest, {
        dur: 0.05,
        gain: 0.09,
        freqStart: 1200 + jitter(700),
        freqEnd: 3200,
        delay: i * 0.035 + jitter(0.01),
        pan: jitter(0.5),
      });
    }
  },
};

/** 播放一个音效（未解锁时静默跳过） */
export function playSfx(name: SfxName): void {
  const dest = audioBus.sfxDestination;
  const ctx = audioBus.context;
  if (!dest || !ctx || ctx.state !== 'running') return;
  players[name](dest, ctx);
}
