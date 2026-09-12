export type SoundEffect = 'deal' | 'flip' | 'chip' | 'win' | 'fold' | 'check';

export interface AudioSettings {
  sfxEnabled: boolean;
  bgmEnabled: boolean;
  sfxVolume: number;
  bgmVolume: number;
}

const storageKey = 'holdem-lab-audio';
const defaults: AudioSettings = { sfxEnabled: true, bgmEnabled: true, sfxVolume: .6, bgmVolume: .1 };

function loadSettings(): AudioSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<AudioSettings>;
    return {
      sfxEnabled: stored.sfxEnabled ?? defaults.sfxEnabled,
      bgmEnabled: stored.bgmEnabled ?? defaults.bgmEnabled,
      sfxVolume: typeof stored.sfxVolume === 'number' ? stored.sfxVolume : defaults.sfxVolume,
      bgmVolume: typeof stored.bgmVolume === 'number' ? stored.bgmVolume : defaults.bgmVolume,
    };
  } catch {
    return defaults;
  }
}

export class AudioManager {
  private settings = loadSettings();
  private listeners = new Set<() => void>();
  private context: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private unlocked = false;
  private roomActive = false;
  private pageVisible = true;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.settings;

  private emit(next: AudioSettings) {
    this.settings = next;
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage is optional. */ }
    this.listeners.forEach((listener) => listener());
    this.syncGains();
  }

  private ensureGraph() {
    if (this.context) return this.context;
    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass();
    this.context = context;
    this.sfxGain = context.createGain();
    this.bgmGain = context.createGain();
    this.sfxGain.connect(context.destination);
    this.bgmGain.connect(context.destination);
    this.syncGains();
    return context;
  }

  async unlock() {
    const context = this.ensureGraph();
    if (!context) return;
    if (context.state === 'suspended') await context.resume();
    this.unlocked = true;
    this.syncBgm();
  }

  setRoomActive(active: boolean) {
    this.roomActive = active;
    this.syncBgm();
  }

  setPageVisible(visible: boolean) {
    this.pageVisible = visible;
    this.syncGains();
  }

  setSfxEnabled(enabled: boolean) { this.emit({ ...this.settings, sfxEnabled: enabled }); }
  setBgmEnabled(enabled: boolean) { this.emit({ ...this.settings, bgmEnabled: enabled }); this.syncBgm(); }
  setSfxVolume(volume: number) { this.emit({ ...this.settings, sfxVolume: Math.max(0, Math.min(1, volume)) }); }
  setBgmVolume(volume: number) { this.emit({ ...this.settings, bgmVolume: Math.max(0, Math.min(1, volume)) }); }

  private syncGains() {
    const now = this.context?.currentTime ?? 0;
    this.sfxGain?.gain.setTargetAtTime(this.settings.sfxEnabled ? this.settings.sfxVolume : 0, now, .02);
    const bgmLevel = this.settings.bgmEnabled && this.roomActive
      ? this.settings.bgmVolume * (this.pageVisible ? 1 : .15)
      : 0;
    this.bgmGain?.gain.setTargetAtTime(bgmLevel, now, .08);
  }

  private syncBgm() {
    if (!this.unlocked || !this.settings.bgmEnabled || !this.roomActive) {
      this.stopBgm();
      this.syncGains();
      return;
    }
    const context = this.ensureGraph();
    if (!context || !this.bgmGain || this.bgmSource) { this.syncGains(); return; }
    const duration = 8;
    const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
    const data = buffer.getChannelData(0);
    const chord = [110, 138.59, 164.81];
    for (let sample = 0; sample < data.length; sample += 1) {
      const time = sample / context.sampleRate;
      const pulse = .7 + .3 * Math.sin(Math.PI * 2 * time / duration);
      data[sample] = chord.reduce((sum, frequency, index) => sum + Math.sin(Math.PI * 2 * frequency * time + index * .7), 0) / chord.length * .08 * pulse;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.bgmGain);
    source.start();
    this.bgmSource = source;
    this.syncGains();
  }

  private stopBgm() {
    if (!this.bgmSource) return;
    try { this.bgmSource.stop(); } catch { /* Source may already be stopped. */ }
    this.bgmSource.disconnect();
    this.bgmSource = null;
  }

  private tone(frequency: number, duration: number, volume: number, type: OscillatorType = 'sine', endFrequency?: number, delay = 0) {
    const context = this.context;
    if (!context || !this.sfxGain) return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(this.sfxGain);
    oscillator.start(start);
    oscillator.stop(start + duration);
  }

  private noise(duration: number, volume: number) {
    const context = this.context;
    if (!context || !this.sfxGain) return;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / data.length);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(volume, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + duration);
    source.connect(gain).connect(this.sfxGain);
    source.start();
  }

  play(effect: SoundEffect) {
    if (!this.unlocked || !this.settings.sfxEnabled) return;
    if (effect === 'deal') this.noise(.09, .22);
    else if (effect === 'flip') this.tone(520, .11, .16, 'triangle', 820);
    else if (effect === 'chip') {
      this.tone(900, .07, .11, 'square', 1200);
      this.tone(1150, .06, .08, 'square', 850, .055);
    } else if (effect === 'win') {
      [523, 659, 784].forEach((frequency, index) => this.tone(frequency, .32, .1, 'triangle', frequency * 1.04, index * .1));
    } else if (effect === 'fold') this.tone(260, .16, .12, 'sine', 120);
    else this.tone(620, .07, .1, 'triangle', 520);
  }
}

export const audioManager = new AudioManager();
