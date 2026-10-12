import { audioBus } from './audioBus';
import { noise, tone } from './synth';

/**
 * 环境音乐：Am7 → Fmaj7 → Cmaj7 → G6 的缓慢循环，
 * 用调度器提前 0.6 秒排程，保证节奏稳定不飘。
 */

const BPM = 66;
const BEAT = 60 / BPM;
const LOOKAHEAD = 0.7;

interface Chord {
  bass: number;
  pad: number[];
  pluck: number[];
}

const PROGRESSION: Chord[] = [
  { bass: 110.0, pad: [220.0, 261.63, 329.63], pluck: [440.0, 523.25, 659.25] }, // Am
  { bass: 87.31, pad: [174.61, 220.0, 261.63], pluck: [349.23, 440.0, 523.25] }, // F
  { bass: 130.81, pad: [261.63, 329.63, 392.0], pluck: [523.25, 659.25, 783.99] }, // C
  { bass: 98.0, pad: [196.0, 246.94, 293.66], pluck: [392.0, 493.88, 587.33] }, // G
];

export class MusicEngine {
  private timer: number | null = null;
  private nextTime = 0;
  private bar = 0;
  private beat = 0;

  get playing(): boolean {
    return this.timer !== null;
  }

  start(): void {
    const dest = audioBus.musicDestination;
    const ctx = audioBus.context;
    if (!dest || !ctx || this.timer !== null) return;
    this.nextTime = ctx.currentTime + 0.15;
    this.bar = 0;
    this.beat = 0;
    this.timer = window.setInterval(() => this.schedule(), 180);
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    audioBus.fadeMusic(0, 0.5);
  }

  private schedule(): void {
    const dest = audioBus.musicDestination;
    const ctx = audioBus.context;
    if (!dest || !ctx) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.scheduleBeat(dest, ctx, this.nextTime);
      this.nextTime += BEAT;
      this.beat += 1;
      if (this.beat % 4 === 0) this.bar += 1;
    }
  }

  private scheduleBeat(dest: AudioNode, ctx: AudioContext, time: number): void {
    const chord = PROGRESSION[this.bar % PROGRESSION.length];
    const delay = Math.max(0, time - ctx.currentTime);
    const inBar = this.beat % 4;

    // 每小节开头的和声铺垫
    if (inBar === 0) {
      chord.pad.forEach((freq, i) => {
        tone(ctx, dest, {
          type: 'triangle',
          freq,
          dur: BEAT * 3.6,
          gain: 0.05,
          attack: 0.9,
          delay,
          detune: i === 1 ? 6 : -5,
          filterFreq: 1500,
          pan: (i - 1) * 0.35,
        });
      });
      tone(ctx, dest, {
        type: 'sine',
        freq: chord.bass,
        dur: BEAT * 3.4,
        gain: 0.09,
        attack: 0.4,
        delay,
        filterFreq: 420,
      });
      // 轻微的沙锤声让循环不呆板
      noise(ctx, dest, {
        dur: 0.5,
        gain: 0.035,
        filterType: 'bandpass',
        freqStart: 5200,
        q: 0.7,
        delay,
        pan: -0.2,
      });
    }

    // 第 2、4 拍点缀一个琴音
    if (inBar === 1 || inBar === 3) {
      const pick = chord.pluck[(this.bar + inBar) % chord.pluck.length];
      tone(ctx, dest, {
        type: 'triangle',
        freq: pick * 2,
        dur: 0.9,
        gain: 0.045,
        attack: 0.01,
        delay: delay + 0.02,
        filterFreq: 3600,
        pan: inBar === 1 ? 0.25 : -0.25,
      });
    }

    if (inBar === 2) {
      noise(ctx, dest, {
        dur: 0.35,
        gain: 0.028,
        filterType: 'bandpass',
        freqStart: 4400,
        q: 0.7,
        delay,
        pan: 0.2,
      });
    }
  }
}

export const music = new MusicEngine();
