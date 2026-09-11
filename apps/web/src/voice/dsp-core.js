/**
 * Sonder — real-time voice conversion DSP core.
 *
 * Plain ES module JavaScript on purpose: this file is loaded verbatim inside an
 * AudioWorkletGlobalScope (which has no bundler, no DOM and no import map) and
 * is also imported directly by the Vitest suite, so the exact code that runs on
 * the audio thread is the code that is tested.
 *
 * =========================================================================
 * HOW THE MALE -> FEMALE TRANSFORM ACTUALLY WORKS
 * =========================================================================
 * Naive pitch shifting (resampling, or a plain phase vocoder) drags the
 * spectral envelope up with the harmonics. That is why "chipmunk" voices sound
 * like a sped-up tape rather than a different person: the *vocal tract* appears
 * to shrink by exactly the same factor as the pitch rises, which never happens
 * in a real speaker.
 *
 * Human voice = an excitation source (vocal folds, sets F0/pitch) filtered by a
 * resonator (vocal tract, sets the formants). Those two are physiologically
 * independent, and a convincing conversion has to treat them independently:
 *
 *   - Adult male F0  ~ 85-155 Hz, adult female F0 ~ 165-255 Hz.
 *   - Female vocal tracts are ~10-15% shorter, moving formants up by ~1.10-1.25x.
 *
 * So each analysis frame is decomposed and rebuilt:
 *
 *   1. STFT (Hann window, 75% overlap)                -> magnitude + phase
 *   2. Cepstral liftering                              -> smooth spectral
 *      envelope (the formants / vocal-tract filter)
 *   3. Divide magnitude by the envelope                -> whitened residual
 *      (the harmonic excitation, i.e. the source)
 *   4. Phase-vocoder pitch shift on the RESIDUAL only  -> new F0, formants
 *      untouched
 *   5. Warp the envelope by formantRatio independently -> shorter vocal tract
 *   6. Multiply the shifted residual by the warped envelope
 *   7. Optional spectral noise gate
 *   8. ISTFT + windowed overlap-add
 *
 * Steps 3-6 are what make pitch and formants independently controllable, and
 * therefore what make this a voice *conversion* rather than a pitch effect.
 *
 * Brightness / resonance EQ and compression are deliberately NOT done here —
 * they are native BiquadFilterNode / DynamicsCompressorNode instances in
 * AudioPipeline.ts, which are cheaper and better than anything hand-rolled.
 */

/* ========================================================================== */
/* FFT                                                                        */
/* ========================================================================== */

/**
 * Iterative in-place radix-2 Cooley-Tukey FFT.
 *
 * Hand-written because an AudioWorklet cannot import a library, and because
 * allocation-free operation matters: everything is preallocated so the audio
 * thread never triggers a garbage collection mid-frame.
 */
export class FFT {
  /** @param {number} size power of two */
  constructor(size) {
    if (size < 4 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 4, got ${size}`);
    }
    this.size = size;
    this.levels = Math.round(Math.log2(size));

    // Bit-reversal permutation table.
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i += 1) {
      let value = i;
      let reversed = 0;
      for (let bit = 0; bit < this.levels; bit += 1) {
        reversed = (reversed << 1) | (value & 1);
        value >>>= 1;
      }
      this.reverse[i] = reversed;
    }

    // Twiddle factors for e^(-2*pi*i*k/N).
    const half = size >> 1;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i += 1) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  /**
   * Forward transform, in place.
   * @param {Float32Array} re
   * @param {Float32Array} im
   */
  forward(re, im) {
    const n = this.size;
    const reverse = this.reverse;

    for (let i = 0; i < n; i += 1) {
      const j = reverse[i];
      if (j > i) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }

    for (let span = 2; span <= n; span <<= 1) {
      const half = span >> 1;
      const step = n / span;
      for (let start = 0; start < n; start += span) {
        for (let j = start, k = 0; j < start + half; j += 1, k += step) {
          const partner = j + half;
          const cos = this.cosTable[k];
          const sin = this.sinTable[k];
          const tre = re[partner] * cos - im[partner] * sin;
          const tim = re[partner] * sin + im[partner] * cos;
          re[partner] = re[j] - tre;
          im[partner] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /**
   * Inverse transform, in place, normalised by 1/N.
   * Implemented as conjugate -> forward -> conjugate -> scale.
   * @param {Float32Array} re
   * @param {Float32Array} im
   */
  inverse(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i += 1) im[i] = -im[i];
    this.forward(re, im);
    const scale = 1 / n;
    for (let i = 0; i < n; i += 1) {
      re[i] *= scale;
      im[i] *= -scale;
    }
  }
}

/* ========================================================================== */
/* Windows and helpers                                                        */
/* ========================================================================== */

/** Periodic Hann window — the correct variant for STFT overlap-add. */
export function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

/**
 * Sum of w[n]^2 across all overlapping hops for one output sample.
 *
 * Applying the window on both analysis and synthesis means overlap-add
 * reconstructs `C * x[n]`, so we divide by C. Computing it from the actual
 * window and hop rather than hard-coding 1.5 keeps the code correct if either
 * is changed.
 */
export function overlapAddNormalisation(window, hopSize) {
  const size = window.length;
  let sum = 0;
  for (let offset = 0; offset < size; offset += hopSize) {
    const value = window[offset];
    sum += value * value;
  }
  return sum || 1;
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

/** Wraps a phase difference into (-PI, PI]. */
export function principalArgument(phase) {
  let wrapped = phase;
  // A loop is faster than fmod here because the input is already near range.
  while (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  while (wrapped < -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

/**
 * Soft knee limiter. Guarantees |y| < 1 without the harsh odd harmonics of a
 * hard clip, so a loud transient cannot send a spike into the WebRTC encoder.
 * Below the threshold it is exactly unity, so normal speech is untouched.
 */
export function softClip(sample, threshold = 0.85) {
  const magnitude = sample < 0 ? -sample : sample;
  if (magnitude <= threshold) return sample;
  const excess = (magnitude - threshold) / (1 - threshold);
  const limited = threshold + (1 - threshold) * Math.tanh(excess);
  return sample < 0 ? -limited : limited;
}

/* ========================================================================== */
/* Spectral envelope (the vocal-tract filter)                                 */
/* ========================================================================== */

/**
 * Estimates the smooth spectral envelope by cepstral liftering.
 *
 * The real cepstrum separates the slowly-varying envelope (low quefrency) from
 * the harmonic comb of the excitation (a peak at quefrency = fs / F0). Keeping
 * only the low-quefrency part therefore recovers the formant structure with the
 * pitch removed — which is exactly the decomposition the conversion needs.
 *
 * The lifter cutoff must sit below fs / F0max so no harmonic structure leaks
 * into the envelope: at 48 kHz with F0 up to ~260 Hz the harmonic peak is at
 * quefrency >= 185, and the default cutoff of ~69 is comfortably clear of it.
 */
export class SpectralEnvelope {
  /**
   * @param {number} fftSize
   * @param {number} sampleRate
   * @param {number} [lifterCutoff] quefrency bins to keep; derived if omitted
   */
  constructor(fftSize, sampleRate, lifterCutoff) {
    this.fftSize = fftSize;
    this.fft = new FFT(fftSize);
    // ~700 Hz of spectral smoothing: fine enough to resolve F1..F3, coarse
    // enough to ignore the harmonic comb.
    this.lifter = clamp(
      lifterCutoff ?? Math.round(sampleRate / 700),
      8,
      Math.floor(fftSize / 8),
    );
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.logMag = new Float32Array(fftSize);
  }

  /**
   * @param {Float32Array} magnitude full-length (symmetric) magnitude spectrum
   * @param {Float32Array} out receives the envelope, same length
   */
  compute(magnitude, out) {
    const n = this.fftSize;
    const EPS = 1e-7;

    for (let i = 0; i < n; i += 1) {
      this.logMag[i] = Math.log(magnitude[i] + EPS);
      this.re[i] = this.logMag[i];
      this.im[i] = 0;
    }

    // Real cepstrum.
    this.fft.inverse(this.re, this.im);

    // Low-pass lifter, keeping the symmetric tail so the result stays real.
    for (let i = this.lifter + 1; i < n - this.lifter; i += 1) {
      this.re[i] = 0;
      this.im[i] = 0;
    }
    for (let i = 0; i < n; i += 1) this.im[i] = 0;

    this.fft.forward(this.re, this.im);

    for (let i = 0; i < n; i += 1) {
      // exp() of the smoothed log spectrum, clamped so a silent frame cannot
      // produce a divide-by-zero when the residual is computed.
      out[i] = Math.max(Math.exp(this.re[i]), EPS);
    }
  }
}

/* ========================================================================== */
/* Frame processor                                                            */
/* ========================================================================== */

/**
 * One STFT frame of the conversion. Stateful across frames because the phase
 * vocoder has to track phase continuity.
 */
export class VoiceFrameProcessor {
  /**
   * @param {{ fftSize?: number, hopSize?: number, sampleRate?: number, lifterCutoff?: number }} options
   */
  constructor(options = {}) {
    this.fftSize = options.fftSize ?? 2048;
    this.hopSize = options.hopSize ?? this.fftSize / 4;
    this.sampleRate = options.sampleRate ?? 48000;
    const n = this.fftSize;
    const bins = n / 2 + 1;

    this.fft = new FFT(n);
    this.envelope = new SpectralEnvelope(n, this.sampleRate, options.lifterCutoff);

    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
    this.magnitude = new Float32Array(n);
    this.phase = new Float32Array(bins);
    this.env = new Float32Array(n);
    this.warpedEnv = new Float32Array(bins);
    this.residual = new Float32Array(bins);

    this.lastPhase = new Float32Array(bins);
    this.sumPhase = new Float32Array(bins);
    this.trueBin = new Float32Array(bins);
    this.shiftedMag = new Float32Array(bins);
    this.shiftedFreq = new Float32Array(bins);

    // Slow per-bin noise floor estimate for the spectral gate.
    this.noiseFloor = new Float32Array(bins);
    this.noiseInitialised = false;

    this.bins = bins;
    this.expectedPhaseAdvance = (2 * Math.PI * this.hopSize) / n;
    this.freqPerBin = this.sampleRate / n;

    /** Smoothed parameters, to avoid zipper noise when a slider moves. */
    this.currentPitchRatio = 1;
    this.currentFormantRatio = 1;

    this.framesProcessed = 0;
  }

  /**
   * Processes one windowed frame in place.
   *
   * @param {Float32Array} frame windowed time-domain input, length fftSize
   * @param {Float32Array} output receives the windowed result, length fftSize
   * @param {{ pitchRatio: number, formantRatio: number, noiseSuppression: number, smoothing?: number }} params
   */
  process(frame, output, params) {
    const n = this.fftSize;
    const bins = this.bins;

    // ---- parameter smoothing ---------------------------------------------
    // A one-pole glide stops a slider drag from producing audible steps.
    const smoothing = params.smoothing ?? 0.25;
    this.currentPitchRatio +=
      (params.pitchRatio - this.currentPitchRatio) * smoothing;
    this.currentFormantRatio +=
      (params.formantRatio - this.currentFormantRatio) * smoothing;
    const pitchRatio = clamp(this.currentPitchRatio, 0.25, 4);
    const formantRatio = clamp(this.currentFormantRatio, 0.5, 2);

    // ---- analysis --------------------------------------------------------
    for (let i = 0; i < n; i += 1) {
      this.re[i] = frame[i];
      this.im[i] = 0;
    }
    this.fft.forward(this.re, this.im);

    for (let i = 0; i < n; i += 1) {
      this.magnitude[i] = Math.hypot(this.re[i], this.im[i]);
    }
    for (let k = 0; k < bins; k += 1) {
      this.phase[k] = Math.atan2(this.im[k], this.re[k]);
    }

    // ---- source / filter separation --------------------------------------
    this.envelope.compute(this.magnitude, this.env);
    for (let k = 0; k < bins; k += 1) {
      this.residual[k] = this.magnitude[k] / this.env[k];
    }

    // ---- spectral noise gate --------------------------------------------
    if (params.noiseSuppression > 0) {
      this.applyNoiseGate(params.noiseSuppression);
    }

    // ---- phase-vocoder pitch shift of the residual -----------------------
    this.shiftResidual(pitchRatio);

    // ---- independent formant warp ---------------------------------------
    this.warpEnvelope(formantRatio);

    // ---- resynthesis -----------------------------------------------------
    for (let k = 0; k < bins; k += 1) {
      const magnitude = this.shiftedMag[k] * this.warpedEnv[k];

      // Accumulate the synthesis phase from the shifted instantaneous
      // frequency. This is what keeps successive frames phase-coherent; using
      // the analysis phase directly would produce a metallic, smeared result.
      this.sumPhase[k] += this.shiftedFreq[k] * this.expectedPhaseAdvance;
      const phase = this.sumPhase[k];

      this.re[k] = magnitude * Math.cos(phase);
      this.im[k] = magnitude * Math.sin(phase);
    }

    // Mirror bins 1..N/2-1 into N-1..N/2+1 with conjugate symmetry, so the
    // inverse transform comes back purely real.
    const half = n >> 1;
    for (let k = 1; k < half; k += 1) {
      this.re[n - k] = this.re[k];
      this.im[n - k] = -this.im[k];
    }
    // DC and Nyquist are their own conjugates and must be real.
    this.im[0] = 0;
    this.im[half] = 0;

    this.fft.inverse(this.re, this.im);

    for (let i = 0; i < n; i += 1) output[i] = this.re[i];

    this.framesProcessed += 1;
  }

  /**
   * Estimates a per-bin noise floor and subtracts it.
   *
   * Minimum statistics: the floor tracks downwards quickly and upwards very
   * slowly, so it settles on the quiet background between words rather than on
   * speech. Gain is then Wiener-like and floored, because gating all the way to
   * zero sounds like a broken connection.
   */
  applyNoiseGate(strength) {
    const bins = this.bins;
    const amount = clamp(strength, 0, 1);

    if (!this.noiseInitialised) {
      for (let k = 0; k < bins; k += 1) this.noiseFloor[k] = this.magnitude[k];
      this.noiseInitialised = true;
      return;
    }

    for (let k = 0; k < bins; k += 1) {
      const mag = this.magnitude[k];
      const floor = this.noiseFloor[k];
      // Fast down (0.5), slow up (0.0005): follow the quiet, ignore the loud.
      this.noiseFloor[k] =
        mag < floor ? floor + (mag - floor) * 0.5 : floor + (mag - floor) * 0.0005;

      const threshold = this.noiseFloor[k] * (1 + 2 * amount);
      if (mag <= 1e-9) {
        this.residual[k] = 0;
        continue;
      }
      const gain = clamp((mag - threshold) / mag, 1 - amount, 1);
      this.residual[k] *= gain;
    }
  }

  /**
   * Phase-vocoder pitch shift, applied to the whitened residual so the formants
   * stay where they were.
   *
   * Uses a *gather* (backward) mapping — for each output bin, read from
   * `j / pitchRatio` with interpolation — rather than the more commonly seen
   * scatter mapping. Scattering `round(k * ratio)` leaves empty output bins
   * whenever ratio > 1, and those spectral holes are audible as a thin,
   * warbling quality. Gathering fills every output bin by construction.
   */
  shiftResidual(pitchRatio) {
    const bins = this.bins;
    const advance = this.expectedPhaseAdvance;

    // Instantaneous frequency (in bin units) of every analysis bin. Computed
    // for all bins up front because the gather step interpolates between them.
    for (let k = 0; k < bins; k += 1) {
      const delta = principalArgument(
        this.phase[k] - this.lastPhase[k] - k * advance,
      );
      this.lastPhase[k] = this.phase[k];
      this.trueBin[k] = k + delta / advance;
    }

    for (let j = 0; j < bins; j += 1) {
      const source = j / pitchRatio;
      if (source >= bins - 1) {
        this.shiftedMag[j] = 0;
        this.shiftedFreq[j] = j;
        continue;
      }
      const lower = source | 0;
      const fraction = source - lower;
      const inverse = 1 - fraction;

      this.shiftedMag[j] =
        this.residual[lower] * inverse + this.residual[lower + 1] * fraction;
      this.shiftedFreq[j] =
        (this.trueBin[lower] * inverse + this.trueBin[lower + 1] * fraction) *
        pitchRatio;
    }
  }

  /**
   * Resamples the spectral envelope along the frequency axis.
   *
   * warped[k] = env[k / formantRatio], so formantRatio > 1 moves the formants
   * upwards — the spectral signature of a shorter vocal tract. Linear
   * interpolation is plenty: the envelope is already smooth by construction.
   */
  warpEnvelope(formantRatio) {
    const bins = this.bins;
    for (let k = 0; k < bins; k += 1) {
      const source = k / formantRatio;
      if (source >= bins - 1) {
        this.warpedEnv[k] = this.env[bins - 1];
        continue;
      }
      const lower = Math.floor(source);
      const fraction = source - lower;
      this.warpedEnv[k] =
        this.env[lower] * (1 - fraction) + this.env[lower + 1] * fraction;
    }
  }

  /** Clears phase history. Call when the stream restarts to avoid artefacts. */
  reset() {
    this.lastPhase.fill(0);
    this.sumPhase.fill(0);
    this.noiseFloor.fill(0);
    this.noiseInitialised = false;
    this.currentPitchRatio = 1;
    this.currentFormantRatio = 1;
    this.framesProcessed = 0;
  }
}

/* ========================================================================== */
/* Streaming wrapper                                                          */
/* ========================================================================== */

/**
 * Turns the frame processor into a continuous stream processor: input ring
 * buffer, hop-aligned analysis, windowed overlap-add output, and loudness
 * matching so switching the effect on does not change how loud you sound.
 */
export class StreamingVoiceProcessor {
  constructor(options = {}) {
    this.fftSize = options.fftSize ?? 2048;
    this.hopSize = options.hopSize ?? this.fftSize / 4;
    this.sampleRate = options.sampleRate ?? 48000;

    this.frameProcessor = new VoiceFrameProcessor({
      fftSize: this.fftSize,
      hopSize: this.hopSize,
      sampleRate: this.sampleRate,
      lifterCutoff: options.lifterCutoff,
    });

    this.window = hannWindow(this.fftSize);
    this.normalisation = overlapAddNormalisation(this.window, this.hopSize);

    this.inputBuffer = new Float32Array(this.fftSize);
    this.inputFill = 0;

    /**
     * Overlap-add accumulator, a power-of-two ring so indexing is a mask rather
     * than a modulo and nothing ever has to be memmoved on the audio thread.
     * Length 2x fftSize leaves room for the in-flight accumulation region plus
     * the finished-but-unread tail.
     */
    this.ringSize = this.fftSize * 2;
    this.ringMask = this.ringSize - 1;
    this.ring = new Float32Array(this.ringSize);
    this.ringRead = 0;
    this.ringWrite = 0;
    /** Samples that are final (no future frame will touch them) and unread. */
    this.pendingOut = 0;

    this.frame = new Float32Array(this.fftSize);
    this.processed = new Float32Array(this.fftSize);

    this.params = {
      pitchRatio: 1,
      formantRatio: 1,
      noiseSuppression: 0,
      smoothing: 0.25,
    };

    /**
     * Loudness matching.
     *
     * Both RMS estimates are taken on the *continuous streams*, per sample, not
     * on windowed frames. Comparing an unwindowed input frame against a windowed
     * output frame is not comparing like with like — a Hann window removes about
     * 4 dB of RMS on its own — and doing so makes the makeup gain settle far too
     * high. The output side is measured before the gain is applied, so there is
     * no feedback loop.
     */
    this.inputMeanSquare = 0;
    this.outputMeanSquare = 0;
    this.makeupGain = 1;
    // ~50 ms level detector, ~250 ms gain glide, both at the sample rate.
    this.levelAlpha = 1 - Math.exp(-1 / (0.05 * this.sampleRate));
    this.gainAlpha = 1 - Math.exp(-1 / (0.25 * this.sampleRate));

    this.framesProcessed = 0;
    this.underruns = 0;
  }

  /**
   * @param {{ pitchSemitones?: number, formantRatio?: number, noiseSuppression?: number, smoothing?: number }} params
   */
  setParams(params) {
    if (typeof params.pitchSemitones === 'number') {
      this.params.pitchRatio = semitonesToRatio(clamp(params.pitchSemitones, -24, 24));
    }
    if (typeof params.formantRatio === 'number') {
      this.params.formantRatio = clamp(params.formantRatio, 0.5, 2);
    }
    if (typeof params.noiseSuppression === 'number') {
      this.params.noiseSuppression = clamp(params.noiseSuppression, 0, 1);
    }
    if (typeof params.smoothing === 'number') {
      this.params.smoothing = clamp(params.smoothing, 0.01, 1);
    }
  }

  /**
   * Algorithmic latency in milliseconds: one full analysis window has to be
   * buffered before any output can be produced.
   */
  get latencyMs() {
    return (this.fftSize / this.sampleRate) * 1000;
  }

  /**
   * Streams `input` in and `output` out. Both must be the same length; any
   * length is accepted, including a 128-sample render quantum.
   *
   * @param {Float32Array} input
   * @param {Float32Array} output
   */
  process(input, output) {
    const hop = this.hopSize;
    const size = this.fftSize;
    const mask = this.ringMask;

    for (let i = 0; i < input.length; i += 1) {
      const dry = input[i];
      this.inputBuffer[this.inputFill] = dry;
      this.inputFill += 1;
      this.inputMeanSquare += (dry * dry - this.inputMeanSquare) * this.levelAlpha;

      if (this.inputFill === size) {
        this.processFrame();
        // Slide the analysis window forward by one hop. One memmove per hop,
        // not per sample.
        this.inputBuffer.copyWithin(0, hop);
        this.inputFill = size - hop;
      }

      if (this.pendingOut > 0) {
        const wet = this.ring[this.ringRead];
        // Zero the slot so it is clean when the ring wraps back around.
        this.ring[this.ringRead] = 0;
        this.ringRead = (this.ringRead + 1) & mask;
        this.pendingOut -= 1;

        this.outputMeanSquare += (wet * wet - this.outputMeanSquare) * this.levelAlpha;
        this.updateMakeupGain();
        output[i] = softClip(wet * this.makeupGain);
      } else {
        output[i] = 0;
        // The first fftSize samples are the algorithm's inherent latency, not a
        // fault. Anything after that is a genuine buffer underrun worth showing.
        if (this.framesProcessed > 0) this.underruns += 1;
      }
    }
  }

  /**
   * Glides the makeup gain towards whatever would make the processed stream as
   * loud as the dry one. Held still during near-silence so the gain does not
   * run away trying to amplify the noise floor between words.
   */
  updateMakeupGain() {
    const inRms = Math.sqrt(this.inputMeanSquare);
    const outRms = Math.sqrt(this.outputMeanSquare);
    if (inRms > 1e-4 && outRms > 1e-4) {
      const target = clamp(inRms / outRms, 0.25, 4);
      this.makeupGain += (target - this.makeupGain) * this.gainAlpha;
    }
  }

  processFrame() {
    const size = this.fftSize;
    const window = this.window;
    const mask = this.ringMask;

    for (let i = 0; i < size; i += 1) {
      this.frame[i] = this.inputBuffer[i] * window[i];
    }

    this.frameProcessor.process(this.frame, this.processed, this.params);

    // Synthesis window + overlap-add normalisation. Loudness matching happens
    // per sample on the reconstructed stream, not here.
    const scale = 1 / this.normalisation;
    for (let i = 0; i < size; i += 1) {
      this.ring[(this.ringWrite + i) & mask] += this.processed[i] * window[i] * scale;
    }

    // Exactly one hop of samples becomes final per frame: no frame after this
    // one starts before ringWrite + hop, so that span can never change again.
    this.ringWrite = (this.ringWrite + this.hopSize) & mask;
    this.pendingOut += this.hopSize;
    this.framesProcessed += 1;
  }

  reset() {
    this.frameProcessor.reset();
    this.inputBuffer.fill(0);
    this.ring.fill(0);
    this.inputFill = 0;
    this.ringRead = 0;
    this.ringWrite = 0;
    this.pendingOut = 0;
    this.inputMeanSquare = 0;
    this.outputMeanSquare = 0;
    this.makeupGain = 1;
    this.framesProcessed = 0;
    this.underruns = 0;
  }
}
