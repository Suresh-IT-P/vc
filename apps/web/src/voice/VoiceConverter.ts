import type {
  VoiceConverterType,
  VoiceEngineErrorCode,
  VoiceMetrics,
  VoiceParams,
  VoicePresetId,
} from '@sonder/shared';

export type VoiceOverrides = Partial<Omit<VoiceParams, 'intensity'>>;

/**
 * The contract the calling code depends on.
 *
 * CallSession never imports a concrete converter — it asks the factory for one
 * and only ever sees this interface. That is what makes the V3 upgrade path
 * real: dropping an ONNX/WASM model in means writing one more implementation of
 * this interface, with no change to the WebRTC or signalling layers.
 *
 * A note on `process(AudioBuffer)`: real-time conversion happens inside an
 * AudioWorklet on the audio thread, so the live path is the node graph
 * (`connect`), not this method. `process` exists for offline work — the preset
 * preview, and tests — and is therefore async, because an OfflineAudioContext
 * render is. Pretending it could be a synchronous `AudioBuffer -> AudioBuffer`
 * call would be a lie about how Web Audio works.
 */
export interface VoiceConverter {
  readonly type: VoiceConverterType;
  /** True once initialised and actually transforming audio. */
  readonly isActive: boolean;
  readonly preset: VoicePresetId;
  readonly intensity: number;

  initialize(context: BaseAudioContext): Promise<void>;

  /** Inserts the converter into the graph and returns its output node. */
  connect(source: AudioNode): AudioNode;
  disconnect(): void;

  /** Offline convenience path. Not used by live calls. */
  process(input: AudioBuffer): Promise<AudioBuffer>;

  setPreset(preset: VoicePresetId): void;
  setIntensity(value: number): void;
  setOverrides(overrides: VoiceOverrides): void;
  /** Enables/disables the transform without tearing the graph down. */
  setEnabled(enabled: boolean): void;

  getMetrics(): VoiceMetrics;
  getParams(): VoiceParams;

  destroy(): void;
}

export class VoiceEngineError extends Error {
  readonly code: VoiceEngineErrorCode;
  /** Text safe to put straight in front of a user. */
  readonly userMessage: string;

  constructor(code: VoiceEngineErrorCode, userMessage: string, cause?: unknown) {
    super(`${code}: ${userMessage}`, { cause });
    this.name = 'VoiceEngineError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export interface VoiceConverterOptions {
  type: VoiceConverterType;
  preset?: VoicePresetId;
  intensity?: number;
  overrides?: VoiceOverrides;
  /** Absolute URL of the built worklet. Defaults to /worklets/voice-processor.js */
  workletUrl?: string;
  fftSize?: number;
  hopSize?: number;
}

/** True when this browser can run the DSP engine at all. */
export function isVoiceEngineSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return Boolean(
    AudioCtor &&
      typeof AudioWorkletNode !== 'undefined' &&
      typeof MediaStreamAudioDestinationNode !== 'undefined',
  );
}
