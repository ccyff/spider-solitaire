/**
 * 极简 Web Audio 合成原语。
 * 所有音效都是实时算出来的，不需要下载任何音频文件，首屏就有效果。
 */

let noiseBuffer: AudioBuffer | null = null;

export function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const seconds = 2;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  noiseBuffer = buffer;
  return buffer;
}

export interface ToneOptions {
  freq: number;
  freqEnd?: number;
  type?: OscillatorType;
  dur: number;
  gain?: number;
  attack?: number;
  delay?: number;
  detune?: number;
  filterFreq?: number;
  filterType?: BiquadFilterType;
  pan?: number;
}

/** 一段带包络的振荡器音 */
export function tone(ctx: BaseAudioContext, dest: AudioNode, opts: ToneOptions): void {
  const {
    freq,
    freqEnd,
    type = 'sine',
    dur,
    gain = 0.2,
    attack = 0.005,
    delay = 0,
    detune = 0,
    filterFreq,
    filterType = 'lowpass',
    pan = 0,
  } = opts;

  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (freqEnd && freqEnd !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + dur);
  }
  if (detune) osc.detune.setValueAtTime(detune, start);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.linearRampToValueAtTime(gain, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  let node: AudioNode = osc;
  node.connect(env);
  node = env;

  if (filterFreq) {
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, start);
    node.connect(filter);
    node = filter;
  }

  if (pan && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), start);
    node.connect(panner);
    node = panner;
  }

  node.connect(dest);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

export interface NoiseOptions {
  dur: number;
  gain?: number;
  delay?: number;
  filterType?: BiquadFilterType;
  freqStart?: number;
  freqEnd?: number;
  q?: number;
  attack?: number;
  pan?: number;
}

/** 一段带包络的噪声（翻牌、洗牌、气流等） */
export function noise(ctx: BaseAudioContext, dest: AudioNode, opts: NoiseOptions): void {
  const {
    dur,
    gain = 0.15,
    delay = 0,
    filterType = 'bandpass',
    freqStart = 1000,
    freqEnd,
    q = 1,
    attack = 0.004,
    pan = 0,
  } = opts;

  const start = ctx.currentTime + delay;
  const source = ctx.createBufferSource();
  source.buffer = getNoiseBuffer(ctx);
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.Q.setValueAtTime(q, start);
  filter.frequency.setValueAtTime(freqStart, start);
  if (freqEnd && freqEnd !== freqStart) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), start + dur);
  }

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.linearRampToValueAtTime(gain, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  source.connect(filter);
  filter.connect(env);

  let node: AudioNode = env;
  if (pan && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), start);
    node.connect(panner);
    node = panner;
  }
  node.connect(dest);

  source.start(start);
  source.stop(start + dur + 0.05);
}
