export type VoicePresetId =
  | 'female-natural'
  | 'female-soft'
  | 'female-bright'
  | 'female-deep'
  | 'female-clear';

export type VoiceConverterType = 'dsp' | 'ai' | 'disabled';

/**
 * The tunable DSP parameters. `intensity` scales every offset from neutral so
 * a single slider moves the whole transform between "off" and "full preset".
 */
export interface VoiceParams {
  /** Pitch shift in semitones. Positive = higher. */
  pitchSemitones: number;
  /** Spectral-envelope (formant) warp factor. >1 = shorter vocal tract. */
  formantRatio: number;
  /** High-shelf gain in dB applied at ~4.5 kHz. */
  brightnessDb: number;
  /** Peaking-filter gain in dB around the vocal presence region. */
  resonanceDb: number;
  /** Centre frequency of the resonance peak, Hz. */
  resonanceHz: number;
  /** Spectral noise-gate strength, 0..1. */
  noiseSuppression: number;
  /** 0..1 master blend between dry and fully-transformed signal. */
  intensity: number;
}

export interface VoicePreset {
  id: VoicePresetId;
  label: string;
  description: string;
  params: Omit<VoiceParams, 'intensity'>;
}

/** Runtime health of the audio pipeline, surfaced in the call UI. */
export interface VoiceMetrics {
  /** Algorithmic + buffering latency introduced by the converter, ms. */
  latencyMs: number;
  /** Fraction of the audio budget consumed by the worklet, 0..1. */
  cpuLoad: number;
  /** Count of render quanta that could not be filled in time. */
  underruns: number;
  /** Frames processed since the converter was started. */
  framesProcessed: number;
  active: boolean;
}

export type VoiceEngineErrorCode =
  | 'WORKLET_UNSUPPORTED'
  | 'WORKLET_LOAD_FAILED'
  | 'CONTEXT_FAILED'
  | 'MIC_DENIED'
  | 'MIC_UNAVAILABLE'
  | 'PROCESSING_FAILED'
  | 'ENGINE_UNAVAILABLE';
