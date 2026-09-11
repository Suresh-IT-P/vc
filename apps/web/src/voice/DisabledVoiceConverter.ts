import {
  DEFAULT_VOICE_PRESET,
  resolveVoiceParams,
  type VoiceConverterType,
  type VoiceMetrics,
  type VoiceParams,
  type VoicePresetId,
} from '@sonder/shared';
import type {
  VoiceConverter,
  VoiceOverrides,
} from './VoiceConverter';

/**
 * Null-object converter: a real, honest pass-through.
 *
 * It exists so the calling code has exactly one code path. CallSession always
 * holds a VoiceConverter; "voice changer off" is this object rather than a
 * null check scattered through the WebRTC layer.
 *
 * Crucially it reports `isActive: false` and zero latency, and `process()`
 * returns the input untouched. It never claims to have transformed anything.
 */
export class DisabledVoiceConverter implements VoiceConverter {
  readonly type: VoiceConverterType = 'disabled';
  readonly isActive = false;

  private currentPreset: VoicePresetId = DEFAULT_VOICE_PRESET;
  private passthrough: GainNode | null = null;
  private source: AudioNode | null = null;

  get preset(): VoicePresetId {
    return this.currentPreset;
  }

  get intensity(): number {
    return 0;
  }

  async initialize(context: BaseAudioContext): Promise<void> {
    // A unity-gain node keeps the graph shape identical to the DSP engine's, so
    // swapping engines mid-call does not require rewiring anything upstream.
    this.passthrough = context.createGain();
    this.passthrough.gain.value = 1;
  }

  connect(source: AudioNode): AudioNode {
    if (!this.passthrough) {
      throw new Error('DisabledVoiceConverter.initialize() was not called');
    }
    this.source = source;
    source.connect(this.passthrough);
    return this.passthrough;
  }

  disconnect(): void {
    try {
      if (this.source && this.passthrough) this.source.disconnect(this.passthrough);
    } catch {
      // Already disconnected.
    }
    this.source = null;
  }

  async process(input: AudioBuffer): Promise<AudioBuffer> {
    return input;
  }

  setPreset(preset: VoicePresetId): void {
    // Remembered so toggling the engine back on restores the user's choice.
    this.currentPreset = preset;
  }

  setIntensity(): void {
    /* no-op: nothing to scale */
  }

  setOverrides(_overrides: VoiceOverrides): void {
    /* no-op */
  }

  setEnabled(): void {
    /* no-op: this converter is the "off" state */
  }

  getParams(): VoiceParams {
    return resolveVoiceParams(this.currentPreset, 0);
  }

  getMetrics(): VoiceMetrics {
    return {
      latencyMs: 0,
      cpuLoad: 0,
      underruns: 0,
      framesProcessed: 0,
      active: false,
    };
  }

  destroy(): void {
    this.disconnect();
    this.passthrough?.disconnect();
    this.passthrough = null;
  }
}
