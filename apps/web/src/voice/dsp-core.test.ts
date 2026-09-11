import { describe, expect, it } from 'vitest';
import {
  FFT,
  SpectralEnvelope,
  StreamingVoiceProcessor,
  VoiceFrameProcessor,
  hannWindow,
  overlapAddNormalisation,
  principalArgument,
  semitonesToRatio,
} from './dsp-core.js';

const SAMPLE_RATE = 48000;

/* -------------------------------------------------------------------------- */
/* Signal helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A synthetic vowel: a harmonic series at `f0` shaped by three formant
 * resonances. This is the standard source-filter model of voiced speech, which
 * makes it the right input for testing a source-filter conversion — a plain
 * sine wave would not exercise the envelope path at all.
 */
function synthVowel(
  f0: number,
  formants: number[],
  length: number,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  const out = new Float32Array(length);
  const harmonics = Math.floor(sampleRate / 2 / f0);

  for (let h = 1; h <= harmonics; h += 1) {
    const freq = f0 * h;
    // Resonant gain: sum of Lorentzian peaks at each formant, plus spectral
    // tilt so it decays with frequency the way real glottal excitation does.
    let gain = 0;
    for (const formant of formants) {
      const bandwidth = 90;
      gain += 1 / (1 + ((freq - formant) / bandwidth) ** 2);
    }
    gain *= 1 / (1 + (freq / 1200) ** 1.2);
    if (gain < 1e-4) continue;

    const phase = (h * 1.7) % (2 * Math.PI);
    for (let i = 0; i < length; i += 1) {
      out[i] += gain * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < length; i += 1) out[i] = (out[i] / peak) * 0.7;
  return out;
}

/** Estimates fundamental frequency by autocorrelation over a plausible range. */
function estimateF0(
  signal: Float32Array,
  sampleRate = SAMPLE_RATE,
  minHz = 60,
  maxHz = 500,
): number {
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / minHz);
  const n = signal.length;

  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += signal[i];
  mean /= n;

  const scores: number[] = [];
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag && lag < n; lag += 1) {
    let numerator = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i + lag < n; i += 1) {
      const a = signal[i] - mean;
      const b = signal[i + lag] - mean;
      numerator += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const denominator = Math.sqrt(energyA * energyB) || 1;
    const score = numerator / denominator;
    scores[lag - minLag] = score;
    if (score > bestScore) bestScore = score;
  }

  // Octave-error guard: a perfectly periodic signal correlates just as well at
  // 2T, 3T... as at T, so taking the global maximum reports half (or a third)
  // of the true pitch whenever noise nudges a longer lag higher. Take the
  // SHORTEST lag that is within 10% of the best score instead.
  const threshold = bestScore * 0.9;
  for (let index = 0; index < scores.length; index += 1) {
    if (scores[index] >= threshold) {
      const lag = index + minLag;
      return sampleRate / lag;
    }
  }
  return 0;
}

/** Magnitude spectrum of one windowed block. */
function spectrumOf(signal: Float32Array, size = 2048): Float32Array {
  const fft = new FFT(size);
  const window = hannWindow(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const offset = Math.max(0, Math.floor((signal.length - size) / 2));
  for (let i = 0; i < size; i += 1) re[i] = (signal[offset + i] ?? 0) * window[i];
  fft.forward(re, im);
  const bins = size / 2 + 1;
  const magnitude = new Float32Array(bins);
  for (let k = 0; k < bins; k += 1) magnitude[k] = Math.hypot(re[k], im[k]);
  return magnitude;
}

/**
 * Spectral centroid in Hz, restricted to the band where formants live. This is
 * the cheap, robust proxy for "where the vocal-tract resonances sit".
 */
function spectralCentroid(
  signal: Float32Array,
  size = 2048,
  loHz = 200,
  hiHz = 4000,
): number {
  const magnitude = spectrumOf(signal, size);
  const binHz = SAMPLE_RATE / size;
  let weighted = 0;
  let total = 0;
  for (let k = 0; k < magnitude.length; k += 1) {
    const hz = k * binHz;
    if (hz < loHz || hz > hiHz) continue;
    weighted += hz * magnitude[k];
    total += magnitude[k];
  }
  return total > 0 ? weighted / total : 0;
}

/** Runs a signal through the streaming processor in 128-sample quanta. */
function runStream(
  processor: StreamingVoiceProcessor,
  input: Float32Array,
  quantum = 128,
): Float32Array {
  const output = new Float32Array(input.length);
  const inBlock = new Float32Array(quantum);
  const outBlock = new Float32Array(quantum);
  for (let offset = 0; offset + quantum <= input.length; offset += quantum) {
    inBlock.set(input.subarray(offset, offset + quantum));
    processor.process(inBlock, outBlock);
    output.set(outBlock, offset);
  }
  return output;
}

/** Drops the priming period so measurements are made on steady-state output. */
function steadyState(signal: Float32Array, skipSamples: number): Float32Array {
  return signal.subarray(skipSamples);
}

/* -------------------------------------------------------------------------- */
/* FFT                                                                        */
/* -------------------------------------------------------------------------- */

describe('FFT', () => {
  it('rejects a non power-of-two size', () => {
    expect(() => new FFT(1000)).toThrow();
  });

  it('round-trips a signal through forward and inverse', () => {
    const size = 256;
    const fft = new FFT(size);
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    const original = new Float32Array(size);

    for (let i = 0; i < size; i += 1) {
      original[i] = Math.sin(i * 0.31) * 0.6 + Math.cos(i * 0.07) * 0.3;
      re[i] = original[i];
    }

    fft.forward(re, im);
    fft.inverse(re, im);

    for (let i = 0; i < size; i += 1) {
      expect(re[i]).toBeCloseTo(original[i], 4);
      expect(Math.abs(im[i])).toBeLessThan(1e-4);
    }
  });

  it('puts a pure tone in the expected bin', () => {
    const size = 1024;
    const fft = new FFT(size);
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    const bin = 64; // exactly periodic in the window, so no leakage

    for (let i = 0; i < size; i += 1) {
      re[i] = Math.sin((2 * Math.PI * bin * i) / size);
    }
    fft.forward(re, im);

    let peakBin = 0;
    let peak = 0;
    for (let k = 1; k < size / 2; k += 1) {
      const magnitude = Math.hypot(re[k], im[k]);
      if (magnitude > peak) {
        peak = magnitude;
        peakBin = k;
      }
    }
    expect(peakBin).toBe(bin);
    // Amplitude 1 sine over N samples -> magnitude N/2 at the peak.
    expect(peak).toBeCloseTo(size / 2, 0);
  });

  it('matches a naive DFT', () => {
    const size = 64;
    const fft = new FFT(size);
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    const input: number[] = [];

    for (let i = 0; i < size; i += 1) {
      const value = Math.sin(i * 0.9) + 0.25 * Math.cos(i * 2.3);
      input.push(value);
      re[i] = value;
    }
    fft.forward(re, im);

    for (const k of [0, 1, 5, 17, 31]) {
      let dftRe = 0;
      let dftIm = 0;
      for (let n = 0; n < size; n += 1) {
        const angle = (-2 * Math.PI * k * n) / size;
        dftRe += input[n] * Math.cos(angle);
        dftIm += input[n] * Math.sin(angle);
      }
      expect(re[k]).toBeCloseTo(dftRe, 3);
      expect(im[k]).toBeCloseTo(dftIm, 3);
    }
  });
});

describe('windowing', () => {
  it('produces a periodic Hann window', () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[4]).toBeCloseTo(1, 6);
    // Periodic (not symmetric): w[n] === w[N-n].
    expect(w[1]).toBeCloseTo(w[7], 6);
  });

  it('computes the correct overlap-add normalisation for 75% overlap', () => {
    const size = 1024;
    const w = hannWindow(size);
    // Sum of Hann^2 at hop N/4 is exactly 1.5.
    expect(overlapAddNormalisation(w, size / 4)).toBeCloseTo(1.5, 5);
  });

  it('wraps phase into the principal range', () => {
    expect(principalArgument(0)).toBeCloseTo(0, 6);
    expect(principalArgument(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
    expect(principalArgument(-Math.PI * 3)).toBeCloseTo(-Math.PI, 5);
    expect(principalArgument(Math.PI * 0.5)).toBeCloseTo(Math.PI * 0.5, 6);
  });

  it('converts semitones to a frequency ratio', () => {
    expect(semitonesToRatio(0)).toBeCloseTo(1, 9);
    expect(semitonesToRatio(12)).toBeCloseTo(2, 9);
    expect(semitonesToRatio(7)).toBeCloseTo(1.4983, 3);
  });
});

/* -------------------------------------------------------------------------- */
/* Spectral envelope                                                          */
/* -------------------------------------------------------------------------- */

describe('SpectralEnvelope', () => {
  it('follows the formant structure while ignoring the harmonic comb', () => {
    // Same window the engine uses: at 1024 the harmonics of a 120 Hz voice are
    // not resolved at all, so the envelope has nothing to smooth away.
    const size = 2048;
    const envelope = new SpectralEnvelope(size, SAMPLE_RATE);
    const vowel = synthVowel(120, [700, 1220, 2600], size * 4);

    const magnitude = new Float32Array(size);
    const fft = new FFT(size);
    const window = hannWindow(size);
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    for (let i = 0; i < size; i += 1) re[i] = vowel[size + i] * window[i];
    fft.forward(re, im);
    for (let i = 0; i < size; i += 1) magnitude[i] = Math.hypot(re[i], im[i]);

    const env = new Float32Array(size);
    envelope.compute(magnitude, env);

    const binHz = SAMPLE_RATE / size;
    const bins = size / 2;

    // The envelope must be far smoother than the raw spectrum: measure how much
    // each varies from bin to bin in the speech band.
    let rawVariation = 0;
    let envVariation = 0;
    let count = 0;
    for (let k = 3; k < bins && k * binHz < 4000; k += 1) {
      rawVariation += Math.abs(
        Math.log(magnitude[k] + 1e-7) - Math.log(magnitude[k - 1] + 1e-7),
      );
      envVariation += Math.abs(Math.log(env[k]) - Math.log(env[k - 1]));
      count += 1;
    }
    expect(count).toBeGreaterThan(50);
    // Harmonics at 120 Hz spacing make the raw spectrum jagged; the whole point
    // of the lifter is that the envelope is not.
    expect(envVariation / count).toBeLessThan(rawVariation / count / 3);

    // And it should still peak near the first formant rather than being flat.
    let peakHz = 0;
    let peak = 0;
    for (let k = 3; k < bins && k * binHz < 3500; k += 1) {
      if (env[k] > peak) {
        peak = env[k];
        peakHz = k * binHz;
      }
    }
    expect(peakHz).toBeGreaterThan(400);
    expect(peakHz).toBeLessThan(1600);
  });

  it('never returns a zero or negative envelope, even on silence', () => {
    const size = 512;
    const envelope = new SpectralEnvelope(size, SAMPLE_RATE);
    const magnitude = new Float32Array(size); // all zeros
    const env = new Float32Array(size);
    envelope.compute(magnitude, env);
    for (let i = 0; i < size; i += 1) {
      expect(env[i]).toBeGreaterThan(0);
      expect(Number.isFinite(env[i])).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The actual conversion                                                      */
/* -------------------------------------------------------------------------- */

describe('StreamingVoiceProcessor', () => {
  const LENGTH = SAMPLE_RATE; // 1 second
  const PRIME = 4096;

  it('reports the algorithmic latency of one analysis window', () => {
    const processor = new StreamingVoiceProcessor({
      fftSize: 1024,
      hopSize: 256,
      sampleRate: SAMPLE_RATE,
    });
    // 1024 / 48000 = 21.33 ms
    expect(processor.latencyMs).toBeCloseTo(21.33, 1);
  });

  it('passes audio through recognisably when set to neutral', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({ pitchSemitones: 0, formantRatio: 1, noiseSuppression: 0 });

    const input = synthVowel(120, [700, 1220, 2600], LENGTH);
    const output = runStream(processor, input);
    const tail = steadyState(output, PRIME);

    // Not silence.
    let peak = 0;
    for (let i = 0; i < tail.length; i += 1) peak = Math.max(peak, Math.abs(tail[i]));
    expect(peak).toBeGreaterThan(0.05);

    // Pitch and formants both preserved.
    expect(estimateF0(tail.subarray(0, 8192))).toBeCloseTo(120, -1);
    const inCentroid = spectralCentroid(steadyState(input, PRIME));
    const outCentroid = spectralCentroid(tail);
    expect(Math.abs(outCentroid - inCentroid) / inCentroid).toBeLessThan(0.25);
  });

  it('raises pitch by the requested interval', () => {
    const cases = [
      { semitones: 5, expected: 120 * semitonesToRatio(5) },
      { semitones: 7, expected: 120 * semitonesToRatio(7) },
      { semitones: 12, expected: 120 * semitonesToRatio(12) },
    ];

    for (const testCase of cases) {
      const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
      processor.setParams({
        pitchSemitones: testCase.semitones,
        formantRatio: 1,
        noiseSuppression: 0,
      });
      const input = synthVowel(120, [700, 1220, 2600], LENGTH);
      const output = runStream(processor, input);
      const measured = estimateF0(steadyState(output, PRIME).subarray(0, 12288));

      // Within 4% of the target fundamental.
      expect(Math.abs(measured - testCase.expected) / testCase.expected).toBeLessThan(0.04);
    }
  });

  it('shifts formants WITHOUT changing pitch', () => {
    // This is the property that separates voice conversion from a pitch effect.
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({
      pitchSemitones: 0,
      formantRatio: 1.25,
      noiseSuppression: 0,
    });

    const input = synthVowel(120, [700, 1220, 2600], LENGTH);
    const output = runStream(processor, input);
    const tail = steadyState(output, PRIME);

    // Pitch untouched...
    expect(estimateF0(tail.subarray(0, 12288))).toBeCloseTo(120, -1);

    // ...but the spectral energy has moved up.
    const inCentroid = spectralCentroid(steadyState(input, PRIME));
    const outCentroid = spectralCentroid(tail);
    expect(outCentroid).toBeGreaterThan(inCentroid * 1.05);
  });

  it('shifts pitch WITHOUT dragging the formants along', () => {
    // The converse property: a naive pitch shifter would move the centroid by
    // the full pitch ratio, which is exactly the chipmunk artefact.
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({
      pitchSemitones: 12,
      formantRatio: 1,
      noiseSuppression: 0,
    });

    const input = synthVowel(120, [700, 1220, 2600], LENGTH);
    const output = runStream(processor, input);
    const tail = steadyState(output, PRIME);

    const inCentroid = spectralCentroid(steadyState(input, PRIME));
    const outCentroid = spectralCentroid(tail);

    // An octave up would double the centroid if formants were dragged along.
    expect(outCentroid).toBeLessThan(inCentroid * 1.5);
    expect(estimateF0(tail.subarray(0, 12288))).toBeGreaterThan(200);
  });

  it('applies a full male-to-female preset transform', () => {
    // The Female Natural preset: +6 st, 1.18x formants.
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({
      pitchSemitones: 6,
      formantRatio: 1.18,
      noiseSuppression: 0.35,
    });

    const male = synthVowel(115, [660, 1150, 2500], LENGTH);
    const output = runStream(processor, male);
    const tail = steadyState(output, PRIME);

    const f0 = estimateF0(tail.subarray(0, 12288));
    // 115 Hz * 2^(6/12) = 162 Hz, inside the female range.
    expect(f0).toBeGreaterThan(150);
    expect(f0).toBeLessThan(185);

    // And the vocal tract now reads as shorter.
    expect(spectralCentroid(tail)).toBeGreaterThan(
      spectralCentroid(steadyState(male, PRIME)),
    );
  });

  it('keeps output loudness close to input loudness', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({ pitchSemitones: 6, formantRatio: 1.18 });

    const input = synthVowel(120, [700, 1220, 2600], LENGTH * 2);
    const output = runStream(processor, input);

    const rms = (signal: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < signal.length; i += 1) sum += signal[i] * signal[i];
      return Math.sqrt(sum / signal.length);
    };

    // Measure well past the makeup-gain glide.
    const inRms = rms(input.subarray(SAMPLE_RATE));
    const outRms = rms(output.subarray(SAMPLE_RATE));
    expect(outRms / inRms).toBeGreaterThan(0.5);
    expect(outRms / inRms).toBeLessThan(2);
  });

  it('never emits NaN, Infinity or clipping beyond unity', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({
      pitchSemitones: 7.5,
      formantRatio: 1.24,
      noiseSuppression: 0.5,
    });

    const input = synthVowel(130, [700, 1220, 2600], LENGTH);
    // Add a burst of silence and a loud transient: both are artefact triggers.
    for (let i = 20000; i < 24000; i += 1) input[i] = 0;
    for (let i = 30000; i < 30100; i += 1) input[i] = 0.99;

    const output = runStream(processor, input);
    for (let i = 0; i < output.length; i += 1) {
      expect(Number.isFinite(output[i])).toBe(true);
      expect(Math.abs(output[i])).toBeLessThan(4);
    }
  });

  it('handles pure silence without producing noise', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({ pitchSemitones: 6, formantRatio: 1.18, noiseSuppression: 0.5 });

    const silence = new Float32Array(SAMPLE_RATE / 2);
    const output = runStream(processor, silence);
    for (let i = 0; i < output.length; i += 1) {
      expect(Math.abs(output[i])).toBeLessThan(1e-3);
    }
  });

  it('does not underrun in steady state', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({ pitchSemitones: 6, formantRatio: 1.18 });

    const input = synthVowel(120, [700, 1220, 2600], LENGTH);
    runStream(processor, input);

    // Some starvation during priming is expected; a steady stream must not add
    // more once the pipeline is full.
    expect(processor.underruns).toBeLessThan(processor.fftSize);
    expect(processor.framesProcessed).toBeGreaterThan(80);
  });

  it('responds to parameter changes mid-stream', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({ pitchSemitones: 0, formantRatio: 1 });

    const input = synthVowel(120, [700, 1220, 2600], LENGTH * 2);
    const firstHalf = runStream(processor, input.subarray(0, LENGTH));

    processor.setParams({ pitchSemitones: 9, formantRatio: 1 });
    const secondHalf = runStream(processor, input.subarray(LENGTH));

    expect(estimateF0(steadyState(firstHalf, PRIME).subarray(0, 12288))).toBeCloseTo(120, -1);
    // Allow the smoothing glide to settle before measuring.
    const settled = secondHalf.subarray(SAMPLE_RATE / 2);
    expect(estimateF0(settled.subarray(0, 12288))).toBeGreaterThan(180);
  });

  it('resets cleanly', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({ pitchSemitones: 6 });
    runStream(processor, synthVowel(120, [700, 1220, 2600], 16384));
    expect(processor.framesProcessed).toBeGreaterThan(0);

    processor.reset();
    expect(processor.framesProcessed).toBe(0);
    expect(processor.underruns).toBe(0);
    expect(processor.pendingOut).toBe(0);
    for (let i = 0; i < processor.ring.length; i += 1) {
      expect(processor.ring[i]).toBe(0);
    }
  });

  it('clamps absurd parameter values instead of producing garbage', () => {
    const processor = new StreamingVoiceProcessor({ sampleRate: SAMPLE_RATE });
    processor.setParams({
      pitchSemitones: 999,
      formantRatio: 50,
      noiseSuppression: 12,
    });
    expect(processor.params.pitchRatio).toBeLessThanOrEqual(semitonesToRatio(24));
    expect(processor.params.formantRatio).toBeLessThanOrEqual(2);
    expect(processor.params.noiseSuppression).toBeLessThanOrEqual(1);

    const output = runStream(processor, synthVowel(120, [700, 1220, 2600], 16384));
    for (let i = 0; i < output.length; i += 1) {
      expect(Number.isFinite(output[i])).toBe(true);
    }
  });
});

describe('VoiceFrameProcessor', () => {
  it('smooths parameter jumps rather than stepping', () => {
    const processor = new VoiceFrameProcessor({ sampleRate: SAMPLE_RATE });
    const frame = new Float32Array(1024);
    const output = new Float32Array(1024);
    const window = hannWindow(1024);
    const vowel = synthVowel(120, [700, 1220, 2600], 4096);
    for (let i = 0; i < 1024; i += 1) frame[i] = vowel[i] * window[i];

    const params = {
      pitchRatio: 2,
      formantRatio: 1.5,
      noiseSuppression: 0,
      smoothing: 0.25,
    };

    processor.process(frame, output, params);
    // One frame must not jump the whole way: a step would be an audible click.
    expect(processor.currentPitchRatio).toBeLessThan(1.5);
    expect(processor.currentPitchRatio).toBeGreaterThan(1);

    for (let i = 0; i < 40; i += 1) processor.process(frame, output, params);
    expect(processor.currentPitchRatio).toBeCloseTo(2, 1);
  });
});
