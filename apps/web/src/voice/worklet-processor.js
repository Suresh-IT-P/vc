/**
 * AudioWorkletProcessor wrapper around StreamingVoiceProcessor.
 *
 * Runs on the real-time audio thread. Three rules apply here and are the reason
 * the code looks the way it does:
 *
 *   1. No allocation in `process()`. Every buffer is created up front; a GC
 *      pause on the audio thread is an audible dropout.
 *   2. No blocking, no awaiting, no DOM. Only `Date`, typed arrays and maths.
 *   3. `process()` must return within the render quantum (128 samples, ~2.7 ms
 *      at 48 kHz) or the browser drops the buffer.
 *
 * This file is concatenated with dsp-core.js by scripts/build-worklet.mjs into
 * public/worklets/voice-processor.js. Concatenation rather than `import` because
 * module support in AudioWorklet is uneven across browsers, and a silent failure
 * to load would mean the caller's raw voice goes out instead of the converted
 * one — the one failure mode this feature must never have.
 */

/* global registerProcessor, AudioWorkletProcessor, sampleRate */

class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const settings = (options && options.processorOptions) || {};
    this.fftSize = settings.fftSize || 2048;
    this.hopSize = settings.hopSize || this.fftSize / 4;

    this.engine = new StreamingVoiceProcessor({
      fftSize: this.fftSize,
      hopSize: this.hopSize,
      sampleRate,
    });

    /** When false the worklet is a pure pass-through and burns no CPU on DSP. */
    this.active = true;
    this.running = true;

    // Metrics accumulate here and are posted on an interval; posting every
    // quantum would flood the main thread with ~375 messages a second.
    this.metricsQuanta = 0;
    this.metricsBusyMs = 0;
    this.lastMetricsPost = 0;
    this.METRICS_INTERVAL_QUANTA = 200; // ~0.5 s at 48 kHz

    this.port.onmessage = (event) => this.onMessage(event.data);

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      fftSize: this.fftSize,
      hopSize: this.hopSize,
      latencyMs: this.engine.latencyMs,
    });
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'params':
        this.engine.setParams(message.params || {});
        break;

      case 'active': {
        const next = Boolean(message.value);
        if (next !== this.active) {
          this.active = next;
          // Phase history from before a bypass is meaningless afterwards and
          // would produce a burst of artefacts on re-enable.
          if (next) this.engine.reset();
        }
        break;
      }

      case 'reset':
        this.engine.reset();
        break;

      case 'stop':
        this.running = false;
        break;

      default:
        break;
    }
  }

  process(inputs, outputs) {
    if (!this.running) return false;

    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outChannel = output[0];
    const inChannel = input && input.length > 0 ? input[0] : null;

    // No input yet (the mic node can be connected a beat before it produces
    // audio). Emit silence rather than reading undefined.
    if (!inChannel) {
      outChannel.fill(0);
      this.fanOut(output);
      return true;
    }

    if (!this.active) {
      outChannel.set(inChannel);
      this.fanOut(output);
      return true;
    }

    const started = Date.now();
    this.engine.process(inChannel, outChannel);
    this.metricsBusyMs += Date.now() - started;
    this.metricsQuanta += 1;

    this.fanOut(output);
    this.maybePostMetrics(outChannel.length);
    return true;
  }

  /** Voice is mono; copy it to any additional output channels. */
  fanOut(output) {
    for (let channel = 1; channel < output.length; channel += 1) {
      output[channel].set(output[0]);
    }
  }

  maybePostMetrics(quantumSize) {
    if (this.metricsQuanta < this.METRICS_INTERVAL_QUANTA) return;

    // Date.now() has millisecond resolution, far coarser than one 2.7 ms
    // quantum, so this is only meaningful averaged over many of them — which is
    // exactly what it is. It is an indicator, not a profiler.
    const wallMs = (this.metricsQuanta * quantumSize * 1000) / sampleRate;
    const cpuLoad = wallMs > 0 ? this.metricsBusyMs / wallMs : 0;

    this.port.postMessage({
      type: 'metrics',
      latencyMs: this.engine.latencyMs,
      cpuLoad,
      underruns: this.engine.underruns,
      framesProcessed: this.engine.framesProcessed,
      active: this.active,
    });

    this.metricsQuanta = 0;
    this.metricsBusyMs = 0;
  }
}

registerProcessor('sonder-voice-processor', VoiceProcessor);
