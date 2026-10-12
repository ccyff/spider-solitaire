/**
 * 音频总线：统一管理 AudioContext、音量、静音开关与自动解锁。
 * 浏览器要求先有用户操作才允许出声，所以第一次点击/按键时会自动解锁。
 */

export type SfxName =
  | 'click'
  | 'select'
  | 'deselect'
  | 'flip'
  | 'place'
  | 'invalid'
  | 'deal'
  | 'dealBlocked'
  | 'complete'
  | 'win'
  | 'undo'
  | 'shuffle';

export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private unlocking: Promise<void> | null = null;

  sfxEnabled = true;
  musicEnabled = true;

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sfxDestination(): GainNode | null {
    return this.sfxEnabled ? this.sfxBus : null;
  }

  get musicDestination(): GainNode | null {
    return this.musicEnabled ? this.musicBus : null;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** 在用户手势中调用；重复调用安全 */
  unlock(): Promise<void> {
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.doUnlock().finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }

  private async doUnlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 0.9;
      this.sfxBus.connect(this.master);

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.0;
      this.musicBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setSfxEnabled(enabled: boolean): void {
    this.sfxEnabled = enabled;
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    this.fadeMusic(enabled ? 1 : 0);
  }

  /** 音乐总音量（0..1），内部再做一次平滑淡入淡出 */
  fadeMusic(level: number, seconds = 0.6): void {
    if (!this.ctx || !this.musicBus) return;
    const now = this.ctx.currentTime;
    const target = Math.max(0.0001, level * 0.5);
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(Math.max(0.0001, this.musicBus.gain.value), now);
    this.musicBus.gain.linearRampToValueAtTime(target, now + seconds);
  }

  /** 页面切到后台时静音，回到前台恢复 */
  handleVisibility(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) {
      void this.ctx.suspend();
    } else if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }
}

export const audioBus = new AudioBus();
