import {
  DEFAULT_INTENSITY,
  DEFAULT_VOICE_PRESET,
  type VoiceConverterType,
  type VoiceMetrics,
  type VoiceParams,
  type VoicePresetId,
} from '@sonder/shared';
import { VoiceConverterFactory } from './VoiceConverterFactory';
import {
  VoiceEngineError,
  isVoiceEngineSupported,
  type VoiceConverter,
  type VoiceOverrides,
} from './VoiceConverter';

export interface AudioPipelineEvents {
  onError?: (error: VoiceEngineError) => void;
  onMetrics?: (metrics: VoiceMetrics) => void;
}

/**
 * Owns the whole capture-to-WebRTC audio graph.
 *
 *                       ┌─────────────── wet ───────────────┐
 *   mic ── source ──────┤                                    ├── mix ── out ── MediaStreamDestination
 *                       └── dryDelay ──── dry ───────────────┘                       │
 *                                                                                    └─> pc.addTrack
 *
 * THE TWO DESIGN DECISIONS THAT MATTER
 *
 * 1. The track handed to WebRTC is ALWAYS the destination node's track, never
 *    the raw microphone track. Toggling the voice changer moves gain inside this
 *    graph; it never swaps the track on the RTCPeerConnection. Swapping tracks
 *    would force a renegotiation mid-call — a glitch, and a window in which raw
 *    voice could escape.
 *
 * 2. The dry path is delayed by exactly the converter's algorithmic latency
 *    (42.7 ms) before being mixed. Without that, crossfading between dry and wet
 *    would jump 42 ms in time and sound like a skip. With it, the crossfade is
 *    seamless, which is what makes the changer safe to toggle while talking.
 */
export class AudioPipeline {
  private context: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private converter: VoiceConverter | null = null;

  private dryDelay: DelayNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private mix: GainNode | null = null;
  private output: GainNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;

  private analyser: AnalyserNode | null = null;
  // TypeScript 5.7 made typed arrays generic over their backing buffer, and
  // getFloatTimeDomainData requires the non-shared variant. Pinning it here
  // avoids a cast at every call site.
  private levelBuffer: Float32Array<ArrayBuffer> | null = null;

  private enabled = false;
  private muted = false;
  private engineType: VoiceConverterType = 'dsp';
  private currentPreset: VoicePresetId = DEFAULT_VOICE_PRESET;
  private currentIntensity = DEFAULT_INTENSITY;
  private overrides: VoiceOverrides = {};

  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly events: AudioPipelineEvents = {}) {}

  get isStarted(): boolean {
    return this.context !== null && this.destination !== null;
  }

  get isVoiceChangerEnabled(): boolean {
    return this.enabled && (this.converter?.isActive ?? false);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get preset(): VoicePresetId {
    return this.currentPreset;
  }

  get intensity(): number {
    return this.currentIntensity;
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 0;
  }

  /**
   * The track to hand to RTCPeerConnection. Stable for the whole call.
   */
  get outboundTrack(): MediaStreamTrack | null {
    return this.destination?.stream.getAudioTracks()[0] ?? null;
  }

  get outboundStream(): MediaStream | null {
    return this.destination?.stream ?? null;
  }

  /**
   * Acquires the microphone and builds the graph.
   *
   * Browser-level echo cancellation, noise suppression and AGC are left ON at
   * capture: they run before our processing and are much better than anything
   * we could add, and disabling them to "get a cleaner signal for the DSP" makes
   * calls worse in real rooms.
   */
  async start(options: { deviceId?: string } = {}): Promise<MediaStream> {
    if (this.isStarted) return this.destination!.stream;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new VoiceEngineError(
        'MIC_UNAVAILABLE',
        'This browser cannot access microphones. Note that microphone access requires HTTPS (localhost is exempt).',
      );
    }

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
    } catch (error) {
      throw describeMicError(error);
    }

    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    try {
      this.context = new AudioCtor({ latencyHint: 'interactive' });
    } catch (error) {
      this.stopMic();
      throw new VoiceEngineError(
        'CONTEXT_FAILED',
        'Audio could not be initialised in this browser.',
        error,
      );
    }

    // Autoplay policy: a context created outside a user gesture starts
    // suspended and would silently produce nothing.
    if (this.context.state === 'suspended') {
      await this.context.resume().catch(() => undefined);
    }

    const context = this.context;
    this.source = context.createMediaStreamSource(this.micStream);

    this.dryDelay = context.createDelay(1);
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();
    this.mix = context.createGain();
    this.output = context.createGain();
    this.destination = context.createMediaStreamDestination();

    // Starts fully dry: the changer is opt-in, per call.
    this.dryGain.gain.value = 1;
    this.wetGain.gain.value = 0;
    this.output.gain.value = 1;

    this.source.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.mix);
    this.mix.connect(this.output);
    this.output.connect(this.destination);

    // Level meter, tapped off the final mix so it shows what is actually sent.
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.levelBuffer = new Float32Array(this.analyser.fftSize);
    this.output.connect(this.analyser);

    await this.attachConverter(this.engineType);

    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.events.onMetrics?.(metrics);
    }, 1000);

    return this.destination.stream;
  }

  /**
   * Builds the wet branch. Called on start and whenever the engine changes.
   */
  private async attachConverter(type: VoiceConverterType): Promise<void> {
    if (!this.context || !this.source || !this.wetGain || !this.dryDelay) return;

    this.converter?.destroy();
    this.converter = VoiceConverterFactory.create({
      type,
      preset: this.currentPreset,
      intensity: this.currentIntensity,
      overrides: this.overrides,
    });

    if (this.converter instanceof Object && 'onError' in this.converter) {
      (this.converter as { onError: (e: VoiceEngineError) => void }).onError = (
        error,
      ) => {
        // Processing died: fall back to dry so the call keeps working, and say so.
        this.setVoiceChangerEnabled(false);
        this.events.onError?.(error);
      };
    }

    try {
      await this.converter.initialize(this.context);
      const wetOut = this.converter.connect(this.source);
      wetOut.connect(this.wetGain);
      this.wetGain.connect(this.mix!);

      // Align the dry path with the wet path's algorithmic delay.
      const latencySeconds = this.converter.getMetrics().latencyMs / 1000;
      this.dryDelay.delayTime.value = Math.min(latencySeconds, 1);
      this.engineType = type;
    } catch (error) {
      this.converter = VoiceConverterFactory.create({ type: 'disabled' });
      await this.converter.initialize(this.context);
      this.enabled = false;
      this.dryDelay.delayTime.value = 0;
      this.crossfade(false);
      this.events.onError?.(
        error instanceof VoiceEngineError
          ? error
          : new VoiceEngineError(
              'PROCESSING_FAILED',
              'The voice changer could not start. Your normal voice will be sent.',
              error,
            ),
      );
    }
  }

  async setEngine(type: VoiceConverterType): Promise<void> {
    if (!this.isStarted) {
      this.engineType = type;
      return;
    }
    const wasEnabled = this.enabled;
    this.crossfade(false);
    await this.attachConverter(type);
    if (wasEnabled) this.setVoiceChangerEnabled(true);
  }

  /**
   * Toggles the transform with an equal-power crossfade. This is the single
   * function that decides whether the far end hears the real voice or not.
   */
  setVoiceChangerEnabled(enabled: boolean): void {
    if (!this.converter) return;
    if (enabled && !this.converter.isActive && this.converter.type !== 'dsp') {
      // Nothing to enable — do not pretend otherwise.
      this.enabled = false;
      this.crossfade(false);
      return;
    }
    this.enabled = enabled;
    this.converter.setEnabled(enabled);
    this.crossfade(enabled);
  }

  private crossfade(wet: boolean): void {
    if (!this.context || !this.dryGain || !this.wetGain) return;
    const now = this.context.currentTime;
    // 60 ms constant: fast enough to feel instant, slow enough not to click.
    const glide = 0.06;
    this.dryGain.gain.setTargetAtTime(wet ? 0 : 1, now, glide);
    this.wetGain.gain.setTargetAtTime(wet ? 1 : 0, now, glide);
  }

  setPreset(preset: VoicePresetId): void {
    this.currentPreset = preset;
    this.converter?.setPreset(preset);
  }

  setIntensity(value: number): void {
    this.currentIntensity = Math.min(1, Math.max(0, value));
    this.converter?.setIntensity(this.currentIntensity);
  }

  setOverrides(overrides: VoiceOverrides): void {
    this.overrides = { ...this.overrides, ...overrides };
    this.converter?.setOverrides(overrides);
  }

  resetOverrides(): void {
    this.overrides = {};
    this.converter?.setPreset(this.currentPreset);
  }

  getParams(): VoiceParams | null {
    return this.converter?.getParams() ?? null;
  }

  /**
   * Mutes by disabling the *microphone* track, not just the output gain, so the
   * browser's recording indicator reflects reality and nothing is captured or
   * processed while muted.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.micStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    const outbound = this.outboundTrack;
    if (outbound) outbound.enabled = !muted;
  }

  /** RMS level of the outgoing signal, 0..1, for the level meter. */
  getOutputLevel(): number {
    if (!this.analyser || !this.levelBuffer) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (let i = 0; i < this.levelBuffer.length; i += 1) {
      sum += this.levelBuffer[i] * this.levelBuffer[i];
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length) * 4);
  }

  getMetrics(): VoiceMetrics {
    const base = this.converter?.getMetrics() ?? {
      latencyMs: 0,
      cpuLoad: 0,
      underruns: 0,
      framesProcessed: 0,
      active: false,
    };
    return { ...base, active: this.isVoiceChangerEnabled && base.active };
  }

  getEngineType(): VoiceConverterType {
    return this.converter?.type ?? this.engineType;
  }

  /** Available input devices. Labels are only populated after permission. */
  static async listMicrophones(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput');
  }

  static isSupported(): boolean {
    return isVoiceEngineSupported();
  }

  /** Releases the microphone, the worklet and the AudioContext. */
  async stop(): Promise<void> {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    this.converter?.destroy();
    this.converter = null;

    for (const node of [
      this.source,
      this.dryDelay,
      this.dryGain,
      this.wetGain,
      this.mix,
      this.output,
      this.analyser,
      this.destination,
    ]) {
      try {
        node?.disconnect();
      } catch {
        // Fine: already torn down.
      }
    }

    this.source = null;
    this.dryDelay = null;
    this.dryGain = null;
    this.wetGain = null;
    this.mix = null;
    this.output = null;
    this.analyser = null;
    this.levelBuffer = null;
    this.destination = null;

    this.stopMic();

    if (this.context && this.context.state !== 'closed') {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.enabled = false;
    this.muted = false;
  }

  private stopMic(): void {
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = null;
  }
}

/** Turns a getUserMedia rejection into something a person can act on. */
function describeMicError(error: unknown): VoiceEngineError {
  const name = (error as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new VoiceEngineError(
        'MIC_DENIED',
        'Microphone access was blocked. Allow it in your browser’s address bar, then try the call again.',
        error,
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new VoiceEngineError(
        'MIC_UNAVAILABLE',
        'No microphone was found. Plug one in or pick a different input device.',
        error,
      );
    case 'NotReadableError':
    case 'AbortError':
      return new VoiceEngineError(
        'MIC_UNAVAILABLE',
        'Your microphone is in use by another app. Close it and try again.',
        error,
      );
    default:
      return new VoiceEngineError(
        'MIC_UNAVAILABLE',
        'The microphone could not be opened.',
        error,
      );
  }
}
