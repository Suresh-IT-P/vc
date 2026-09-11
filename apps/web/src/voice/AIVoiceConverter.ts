import {
  DEFAULT_INTENSITY,
  DEFAULT_VOICE_PRESET,
  resolveVoiceParams,
  type VoiceConverterType,
  type VoiceMetrics,
  type VoiceParams,
  type VoicePresetId,
} from '@sonder/shared';
import {
  VoiceEngineError,
  type VoiceConverter,
  type VoiceConverterOptions,
  type VoiceOverrides,
} from './VoiceConverter';

/**
 * ============================ NOT IMPLEMENTED =============================
 *
 * Placeholder for a future neural voice-conversion engine (the "V3" in the
 * roadmap). It is deliberately NOT wired up, and every method fails loudly.
 *
 * WHY IT FAILS INSTEAD OF FALLING BACK
 * A silent fallback to the DSP engine would mean the UI could say "AI Voice"
 * while plain DSP was running — the app would be lying to the user about what
 * their voice is being processed with. Selecting an engine that does not exist
 * is a programming error and is surfaced as one. Nothing in the shipped UI can
 * select it: VOICE_ENGINE_OPTIONS in the settings panel lists only 'dsp' and
 * 'disabled'.
 *
 * WHAT AN IMPLEMENTATION WOULD NEED
 * The interface boundary is already correct — CallSession and AudioPipeline
 * depend only on `VoiceConverter`, so swapping engines does not touch any
 * WebRTC, signalling or UI code. A real implementation would:
 *
 *   1. Ship a quantised any-to-one conversion model (e.g. a RVC/so-vits style
 *      decoder, or a streaming variant of a diffusion-free vocoder) as ONNX,
 *      and run it via onnxruntime-web with the WebGPU or WASM-SIMD backend.
 *   2. Run inference OFF the audio thread. AudioWorklet cannot host WASM
 *      inference within a 2.7 ms render quantum. The realistic topology is:
 *        worklet -> SharedArrayBuffer ring -> Worker (inference) -> ring -> worklet
 *      which requires cross-origin isolation (COOP/COEP headers) for SAB.
 *   3. Accept a larger algorithmic latency. Chunked neural conversion is
 *      typically 80-200 ms, versus 42.7 ms for the DSP path, which is at the
 *      edge of comfortable for a live two-way call. `getMetrics().latencyMs`
 *      must report the truth so the call UI can warn.
 *   4. Keep the DSP engine as the default on low-power devices; measure `cpuLoad`
 *      and fall back explicitly, telling the user it happened.
 *
 * Until all four exist, the honest answer is that this product does DSP voice
 * conversion, and the UI says exactly that.
 * ==========================================================================
 */
export class AIVoiceConverter implements VoiceConverter {
  readonly type: VoiceConverterType = 'ai';
  readonly isActive = false;

  private currentPreset: VoicePresetId;
  private currentIntensity: number;

  constructor(options: VoiceConverterOptions = { type: 'ai' }) {
    this.currentPreset = options.preset ?? DEFAULT_VOICE_PRESET;
    this.currentIntensity = options.intensity ?? DEFAULT_INTENSITY;
  }

  get preset(): VoicePresetId {
    return this.currentPreset;
  }

  get intensity(): number {
    return this.currentIntensity;
  }

  private unavailable(): VoiceEngineError {
    return new VoiceEngineError(
      'ENGINE_UNAVAILABLE',
      'The neural voice engine is not part of this build. Use the DSP engine instead.',
    );
  }

  async initialize(): Promise<void> {
    throw this.unavailable();
  }

  connect(): AudioNode {
    throw this.unavailable();
  }

  disconnect(): void {
    /* nothing was ever connected */
  }

  async process(): Promise<AudioBuffer> {
    throw this.unavailable();
  }

  setPreset(preset: VoicePresetId): void {
    this.currentPreset = preset;
  }

  setIntensity(value: number): void {
    this.currentIntensity = value;
  }

  setOverrides(_overrides: VoiceOverrides): void {
    /* no-op */
  }

  setEnabled(): void {
    /* no-op */
  }

  getParams(): VoiceParams {
    return resolveVoiceParams(this.currentPreset, 0);
  }

  /** Always inactive and always zero: this engine processes nothing. */
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
    /* nothing to release */
  }
}
