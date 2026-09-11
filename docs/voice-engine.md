# The voice engine

The feature this product exists for: converting a male voice to a female one, in
real time, during a live call, without sending audio anywhere.

---

## 1. Why naive pitch shifting fails

Speed up a recording and everything moves together — the pitch *and* the
resonances. The result is the chipmunk effect, and it does not sound like a
different person; it sounds like the same person on fast-forward.

Speech is produced by a **source–filter** system:

| | Physical origin | Acoustic effect |
| --- | --- | --- |
| **Source** | Vocal folds vibrating | Fundamental frequency `F0` — perceived pitch |
| **Filter** | Vocal tract shape and length | **Formants** — the resonant peaks that give a voice its timbre |

Between an adult male and an adult female speaker, both change, but by different
amounts and for different reasons:

| | Male | Female | Ratio |
| --- | --- | --- | --- |
| `F0` | ~85–155 Hz | ~165–255 Hz | ~1.7–2.0× |
| Vocal tract length | ~17 cm | ~14.5 cm | formants ~1.10–1.25× |

A pitch shifter couples these into a single factor. A convincing conversion has
to decouple them — and that is exactly what this engine does.

---

## 2. The pipeline

Per STFT frame, in
[`dsp-core.js`](../apps/web/src/voice/dsp-core.js):

```
                     ┌──────────────────────────────────────────┐
  windowed frame ───►│ 1. FFT              → magnitude + phase   │
                     ├──────────────────────────────────────────┤
                     │ 2. Cepstral lifter  → spectral ENVELOPE   │  ← the filter
                     │                        (formants)         │
                     ├──────────────────────────────────────────┤
                     │ 3. magnitude / envelope → RESIDUAL        │  ← the source
                     │                        (harmonic comb)    │
                     ├──────────────────────────────────────────┤
                     │ 4. Phase-vocoder pitch shift              │
                     │    applied to the RESIDUAL only           │  ← new F0
                     ├──────────────────────────────────────────┤
                     │ 5. Warp ENVELOPE by formantRatio          │  ← new tract
                     ├──────────────────────────────────────────┤
                     │ 6. residual × envelope → new magnitude    │
                     │ 7. spectral noise gate                    │
                     │ 8. IFFT → window → overlap-add            │
                     └──────────────────────────────────────────┘
```

Steps 3–6 are the whole idea. Because the pitch shift operates on the *whitened*
residual, it moves the harmonics without touching the formants; because the
envelope is warped separately, the apparent vocal-tract length changes without
touching the pitch. Two independent knobs.

### Extracting the envelope

The real cepstrum (`IFFT(log|X|)`) separates a spectrum by *rate of variation*:
the slowly-varying envelope sits at low quefrency, and the harmonic comb appears
as a sharp peak at quefrency `fs / F0`. Keeping only the low quefrencies and
transforming back recovers the formant structure with the pitch removed.

The lifter cutoff is `round(sampleRate / 700)` ≈ 69 bins, chosen so it is:

- **high enough** to resolve F1–F3 (which are 500–1000 Hz apart), and
- **well below** the harmonic peak — at 48 kHz even a 260 Hz voice puts that
  peak at quefrency 185, so nothing periodic leaks into the envelope.

### Shifting the pitch

A standard phase vocoder: per bin, the phase advance between frames gives the
true instantaneous frequency, which is scaled by the pitch ratio, and the
synthesis phase is accumulated so successive frames stay coherent.

One deliberate departure from the textbook version: this implementation uses a
**gather** (backward) mapping — for each output bin, read from `j / pitchRatio`
with interpolation — instead of the more common scatter mapping
`round(k * pitchRatio)`. Scattering leaves empty output bins whenever the ratio
is above 1, and those spectral holes are audible as a thin, warbling quality.
Gathering fills every output bin by construction.

---

## 3. Why 2048 and not 1024

A Hann window's main lobe is 4 FFT bins wide, so resolving harmonics `F0` apart
requires `4 × (fs / N) < F0`:

| N @ 48 kHz | Bin | Main lobe | 120 Hz harmonics | Added latency |
| --- | --- | --- | --- | --- |
| 1024 | 46.9 Hz | 187.5 Hz | **smeared** | 21.3 ms |
| **2048** | 23.4 Hz | 93.8 Hz | **resolved** | **42.7 ms** |

At 1024 the source/filter separation degrades badly for precisely the voices this
feature exists to convert. The extra ~21 ms is worth it: total mouth-to-ear then
lands around 75–125 ms including network, comfortably inside ITU-T G.114's 150 ms
"good quality" one-way budget.

Hop is `N/4` (75 % overlap), the standard choice for artefact-free Hann
overlap-add.

---

## 4. What is not in the worklet

Brightness, resonance and compression are **native Web Audio nodes**, not
hand-rolled DSP:

| Control | Implementation |
| --- | --- |
| Brightness | `BiquadFilterNode` high shelf @ 4.5 kHz |
| Resonance | `BiquadFilterNode` peaking bell, preset centre frequency |
| Glue compression | `DynamicsCompressorNode` |

Browsers implement these in optimised native code. Reimplementing them in
JavaScript on the audio thread would be slower and worse.

---

## 5. The audio graph

[`AudioPipeline.ts`](../apps/web/src/voice/AudioPipeline.ts):

```
                        ┌─────────── wet ───────────┐
 mic ─► source ─────────┤                            ├─► mix ─► out ─► MediaStreamDestination
                        └─ dryDelay ─── dry ─────────┘                        │
                                                                   pc.addTrack(track)
```

Two decisions here matter more than the rest of the file:

**1. WebRTC always gets the destination node's track — never the raw microphone.**
Toggling the voice changer moves gain *inside* the graph. It never swaps the
track on the `RTCPeerConnection`, because that would force a mid-call
renegotiation: a glitch, and a window in which raw voice could escape. There is
no code path that adds a microphone track to a peer connection.

**2. The dry path is delayed by exactly the converter's algorithmic latency.**
Without that, crossfading between dry and wet would jump 42 ms in time and sound
like a skip. With it, the crossfade is seamless — which is what makes the changer
safe to toggle mid-sentence.

Capture-side echo cancellation, noise suppression and AGC are left **on**. They
run before our processing and are far better than anything we could add;
disabling them to "get a cleaner signal for the DSP" makes real calls worse.

---

## 6. Presets

Tuned against male speech (`F0` ≈ 95–140 Hz). Defined in
[`voice-presets.ts`](../packages/shared/src/voice-presets.ts).

| Preset | Pitch | Formant | Brightness | Resonance | Character |
| --- | --- | --- | --- | --- | --- |
| Female Natural | +6.0 st | 1.18× | +3.0 dB | +2.0 dB @ 2.6 kHz | Balanced default |
| Female Soft | +5.0 st | 1.14× | −1.5 dB | +1.5 dB @ 1.8 kHz | Warmer, upper-mids pulled back |
| Female Bright | +7.5 st | 1.24× | +5.5 dB | +3.0 dB @ 3.2 kHz | Airy, high-energy |
| Female Deep | +3.5 st | 1.09× | −2.5 dB | +2.5 dB @ 1.2 kHz | Chest-forward, subtlest |
| Female Clear | +6.0 st | 1.20× | +2.0 dB | +4.0 dB @ 3.0 kHz | Tuned for intelligibility |

`intensity` interpolates every parameter from its neutral value (0 st, 1.0×,
0 dB) towards the preset. `0` is a true bypass; `1` is the full preset. Advanced
controls override individual parameters while keeping the rest of the preset.

---

## 7. Engine abstraction

Calling code depends only on the
[`VoiceConverter`](../apps/web/src/voice/VoiceConverter.ts) interface:

```ts
const converter = VoiceConverterFactory.create({
  type: 'dsp',
  preset: 'female-natural',
});
```

| Implementation | Status |
| --- | --- |
| `DSPVoiceConverter` | **V1, shipped.** Everything above. |
| `DisabledVoiceConverter` | Null object. A real pass-through that reports `isActive: false`. |
| `AIVoiceConverter` | **Not implemented.** Throws `ENGINE_UNAVAILABLE`. |

`CallSession` and `AudioPipeline` never import a concrete converter, so replacing
the engine touches no WebRTC, signalling or UI code.

### Why `AIVoiceConverter` throws instead of falling back

A silent fallback would let the UI display "AI Voice" while plain DSP ran — the
app lying to the user about how their voice is being processed. Selecting a
non-existent engine is a programming error and is surfaced as one. Nothing in the
shipped UI can select it.

### Upgrade path (V3)

1. Ship a quantised any-to-one conversion model as ONNX; run it with
   onnxruntime-web on WebGPU or WASM-SIMD.
2. Run inference **off** the audio thread — a worklet cannot host WASM inference
   inside a 2.7 ms render quantum. Realistic topology:
   `worklet → SharedArrayBuffer ring → Worker → ring → worklet`, which needs
   cross-origin isolation (COOP/COEP) for `SharedArrayBuffer`.
3. Report the real latency through `getMetrics().latencyMs`. Chunked neural
   conversion is typically 80–200 ms, versus 42.7 ms here, which is at the edge
   of comfortable for two-way conversation.
4. Keep DSP as the default on low-power devices; measure `cpuLoad` and fall back
   **explicitly**, telling the user it happened.

---

## 8. Build and test

`dsp-core.js` is plain JavaScript, deliberately. An AudioWorkletGlobalScope has
no bundler and no import map, and ES-module support inside worklets is uneven —
a failed import there is *silent*: `registerProcessor` never runs and the caller's
untransformed voice goes out. So
[`scripts/build-worklet.mjs`](../scripts/build-worklet.mjs) concatenates the DSP
core with the processor shell into one classic script, strips the module syntax,
and verifies the result parses by compiling it.

The same `dsp-core.js` is imported directly by the test suite, so the tested code
and the shipped code cannot diverge.

```bash
npm run test:voice
```

The 24 tests verify the maths, not just that it runs:

- FFT round-trips, and matches a naive DFT bin for bin.
- Hann overlap-add normalisation is exactly 1.5 at 75 % overlap.
- The envelope is >3× smoother than the raw spectrum while still peaking near F1.
- Pitch lands within **4 %** of target at +5, +7 and +12 semitones — measured by
  autocorrelation on the output.
- **Formants shift without changing pitch** (spectral centroid rises >5 %,
  measured `F0` unchanged).
- **Pitch shifts without dragging formants** — an octave up moves the centroid by
  far less than 2×, which is the anti-chipmunk property stated as an assertion.
- A full Female Natural transform takes a 115 Hz synthetic male vowel to
  150–185 Hz with a raised centroid.
- Output loudness stays within 0.5–2× of input; no NaN, no Infinity, no clipping
  past unity; silence in gives silence out; no steady-state underruns.
