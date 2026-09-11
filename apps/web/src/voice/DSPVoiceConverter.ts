import {
  DEFAULT_INTENSITY,
  DEFAULT_VOICE_PRESET,
  VOICE_FFT_SIZE,
  VOICE_HOP_SIZE,
  resolveVoiceParams,
  type VoiceConverterType,
  type VoiceMetrics,
  type VoiceParams,
  type VoicePresetId,
} from '@sonder/shared';
import {
  VoiceEngineError,
  isVoiceEngineSupported,
  type VoiceConverter,
  type VoiceConverterOptions,
  type VoiceOverrides,
} from './VoiceConverter';

const DEFAULT_WORKLET_URL = '/worklets/voice-processor.js';

/**
 * The V1 engine: real-time DSP, entirely in the browser.
 *
 * Signal chain owned by this class:
 *
 *   source -> [AudioWorklet: pitch/formant conversion] -> highShelf -> peaking
 *          -> compressor -> output
 *
 * The pitch and formant work happens on the audio thread inside the worklet
 * (see dsp-core.js). Brightness and resonance are native BiquadFilterNodes and
 * the final glue is a DynamicsCompressorNode: those are implemented in optimised
 * native code, so hand-rolling them in the worklet would be slower and worse.
 *
 * Nothing here talks to a server. No audio leaves the machine except through the
 * WebRTC peer connection the user explicitly started.
 */
export class DSPVoiceConverter implements VoiceConverter {
  readonly type: VoiceConverterType = 'dsp';

  private context: BaseAudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private brightness: BiquadFilterNode | null = null;
  private resonance: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private source: AudioNode | null = null;

  private currentPreset: VoicePresetId;
  private currentIntensity: number;
  private overrides: VoiceOverrides;
  private enabled = true;
  private initialised = false;

  private readonly workletUrl: string;
  private readonly fftSize: number;
  private readonly hopSize: number;

  private metrics: VoiceMetrics = {
    latencyMs: 0,
    cpuLoad: 0,
    underruns: 0,
    framesProcessed: 0,
    active: false,
  };

  /** Resolved once the worklet posts its `ready` message. */
  private readyResolve: (() => void) | null = null;

  constructor(options: VoiceConverterOptions = { type: 'dsp' }) {
    this.currentPreset = options.preset ?? DEFAULT_VOICE_PRESET;
    this.currentIntensity = options.intensity ?? DEFAULT_INTENSITY;
    this.overrides = options.overrides ?? {};
    this.workletUrl = options.workletUrl ?? DEFAULT_WORKLET_URL;
    this.fftSize = options.fftSize ?? VOICE_FFT_SIZE;
    this.hopSize = options.hopSize ?? VOICE_HOP_SIZE;
  }

  get isActive(): boolean {
    return this.initialised && this.enabled;
  }

  get preset(): VoicePresetId {
    return this.currentPreset;
  }

  get intensity(): number {
    return this.currentIntensity;
  }

  async initialize(context: BaseAudioContext): Promise<void> {
    if (this.initialised && this.context === context) return;

    if (!isVoiceEngineSupported()) {
      throw new VoiceEngineError(
        'WORKLET_UNSUPPORTED',
        'Your browser does not support the audio processing this needs. Try the latest Chrome, Edge, Firefox or Safari.',
      );
    }

    this.context = context;

    try {
      await context.audioWorklet.addModule(this.workletUrl);
    } catch (error) {
      throw new VoiceEngineError(
        'WORKLET_LOAD_FAILED',
        'The voice processor could not be loaded. Reload the page and try again.',
        error,
      );
    }

    try {
      this.worklet = new AudioWorkletNode(context, 'sonder-voice-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { fftSize: this.fftSize, hopSize: this.hopSize },
      });
    } catch (error) {
      throw new VoiceEngineError(
        'PROCESSING_FAILED',
        'The voice processor could not start.',
        error,
      );
    }

    const ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    this.worklet.port.onmessage = (event: MessageEvent) => {
      this.onWorkletMessage(event.data);
    };
    this.worklet.onprocessorerror = () => {
      // The audio thread threw. Surface it rather than silently sending raw
      // voice: the caller believes they are being transformed.
      this.metrics = { ...this.metrics, active: false };
      this.onError?.(
        new VoiceEngineError(
          'PROCESSING_FAILED',
          'Voice processing stopped unexpectedly. Your normal voice is being sent.',
        ),
      );
    };

    // Brightness: high shelf at 4.5 kHz. Air and presence live here, and it is
    // a large part of why a converted voice reads as feminine rather than
    // merely high-pitched.
    this.brightness = context.createBiquadFilter();
    this.brightness.type = 'highshelf';
    this.brightness.frequency.value = 4500;
    this.brightness.gain.value = 0;

    // Resonance: a peaking bell in the vocal presence region.
    this.resonance = context.createBiquadFilter();
    this.resonance.type = 'peaking';
    this.resonance.frequency.value = 2600;
    this.resonance.Q.value = 1.1;
    this.resonance.gain.value = 0;

    // Gentle glue compression. Evens out the level so the far end does not have
    // to ride their volume, and keeps peaks off the encoder's ceiling.
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -22;
    this.compressor.knee.value = 26;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.18;

    this.worklet.connect(this.brightness);
    this.brightness.connect(this.resonance);
    this.resonance.connect(this.compressor);

    this.initialised = true;
    this.pushParams();

    // Do not block start-up forever if the worklet never reports in.
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  /** Optional error sink, set by AudioPipeline. */
  onError: ((error: VoiceEngineError) => void) | null = null;

  private onWorkletMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const data = message as Record<string, unknown>;

    if (data.type === 'ready') {
      this.metrics = {
        ...this.metrics,
        latencyMs: Number(data.latencyMs) || 0,
        active: true,
      };
      this.readyResolve?.();
      this.readyResolve = null;
      return;
    }

    if (data.type === 'metrics') {
      this.metrics = {
        latencyMs: Number(data.latencyMs) || 0,
        cpuLoad: Number(data.cpuLoad) || 0,
        underruns: Number(data.underruns) || 0,
        framesProcessed: Number(data.framesProcessed) || 0,
        active: Boolean(data.active),
      };
    }
  }

  connect(source: AudioNode): AudioNode {
    if (!this.worklet || !this.compressor) {
      throw new VoiceEngineError(
        'PROCESSING_FAILED',
        'The voice processor is not ready yet.',
      );
    }
    this.source?.disconnect(this.worklet);
    this.source = source;
    source.connect(this.worklet);
    return this.compressor;
  }

  disconnect(): void {
    try {
      if (this.source && this.worklet) this.source.disconnect(this.worklet);
    } catch {
      // Already disconnected.
    }
    this.source = null;
  }

  /**
   * Offline render, used for the preset preview. Builds a throwaway
   * OfflineAudioContext so it cannot disturb the live call graph.
   */
  async process(input: AudioBuffer): Promise<AudioBuffer> {
    const offline = new OfflineAudioContext(
      1,
      input.length,
      input.sampleRate,
    );
    const converter = new DSPVoiceConverter({
      type: 'dsp',
      preset: this.currentPreset,
      intensity: this.currentIntensity,
      overrides: this.overrides,
      workletUrl: this.workletUrl,
      fftSize: this.fftSize,
      hopSize: this.hopSize,
    });
    await converter.initialize(offline);

    const source = offline.createBufferSource();
    source.buffer = input;
    converter.connect(source).connect(offline.destination);
    source.start();

    const rendered = await offline.startRendering();
    converter.destroy();
    return rendered;
  }

  setPreset(preset: VoicePresetId): void {
    this.currentPreset = preset;
    this.pushParams();
  }

  setIntensity(value: number): void {
    this.currentIntensity = Math.min(1, Math.max(0, value));
    this.pushParams();
  }

  setOverrides(overrides: VoiceOverrides): void {
    this.overrides = { ...this.overrides, ...overrides };
    this.pushParams();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.worklet?.port.postMessage({ type: 'active', value: enabled });
    this.pushParams();
  }

  getParams(): VoiceParams {
    return resolveVoiceParams(
      this.currentPreset,
      this.enabled ? this.currentIntensity : 0,
      this.overrides,
    );
  }

  getMetrics(): VoiceMetrics {
    return { ...this.metrics, active: this.isActive && this.metrics.active };
  }

  /**
   * Pushes parameters to the audio thread and the filter nodes.
   *
   * Filter gains are ramped rather than assigned: a step change on an AudioParam
   * is an audible click, and the whole point of the intensity slider is that it
   * can be moved during a live call.
   */
  private pushParams(): void {
    if (!this.initialised || !this.context) return;
    const params = this.getParams();

    this.worklet?.port.postMessage({
      type: 'params',
      params: {
        pitchSemitones: params.pitchSemitones,
        formantRatio: params.formantRatio,
        noiseSuppression: params.noiseSuppression,
      },
    });

    const now = this.context.currentTime;
    const glide = 0.04;
    if (this.brightness) {
      this.brightness.gain.setTargetAtTime(params.brightnessDb, now, glide);
    }
    if (this.resonance) {
      this.resonance.gain.setTargetAtTime(params.resonanceDb, now, glide);
      this.resonance.frequency.setTargetAtTime(params.resonanceHz, now, glide);
    }
  }

  destroy(): void {
    this.disconnect();
    try {
      this.worklet?.port.postMessage({ type: 'stop' });
      this.worklet?.port.close();
    } catch {
      // Port may already be closed.
    }
    this.worklet?.disconnect();
    this.brightness?.disconnect();
    this.resonance?.disconnect();
    this.compressor?.disconnect();

    this.worklet = null;
    this.brightness = null;
    this.resonance = null;
    this.compressor = null;
    this.context = null;
    this.initialised = false;
    this.metrics = { ...this.metrics, active: false };
  }
}
