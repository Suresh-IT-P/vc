import type { VoicePreset, VoicePresetId, VoiceParams } from './types/voice.js';

/**
 * Preset parameters were tuned against male speech (F0 ~95-140 Hz).
 *
 * Why these numbers: a straight octave shift (+12 st) sounds like a chipmunk
 * because it drags the formants up with it. Perceptually convincing
 * male -> female conversion needs the *pitch* raised a moderate amount
 * (+4..+8 st, i.e. ~130 Hz -> ~185-205 Hz) while the *spectral envelope* is
 * warped independently by ~1.10-1.25x to model a shorter vocal tract. Those two
 * axes are decoupled in DSPVoiceConverter, which is what makes this sound like
 * a different speaker rather than a sped-up tape.
 */
export const VOICE_PRESETS: Record<VoicePresetId, VoicePreset> = {
  'female-natural': {
    id: 'female-natural',
    label: 'Female Natural',
    description: 'Balanced, everyday female voice. Best all-round starting point.',
    params: {
      pitchSemitones: 6.0,
      formantRatio: 1.18,
      brightnessDb: 3.0,
      resonanceDb: 2.0,
      resonanceHz: 2600,
      noiseSuppression: 0.35,
    },
  },
  'female-soft': {
    id: 'female-soft',
    label: 'Female Soft',
    description: 'Smoother and warmer, with the harsh upper-mids pulled back.',
    params: {
      pitchSemitones: 5.0,
      formantRatio: 1.14,
      brightnessDb: -1.5,
      resonanceDb: 1.5,
      resonanceHz: 1800,
      noiseSuppression: 0.45,
    },
  },
  'female-bright': {
    id: 'female-bright',
    label: 'Female Bright',
    description: 'Airy, high-energy character with lifted high frequencies.',
    params: {
      pitchSemitones: 7.5,
      formantRatio: 1.24,
      brightnessDb: 5.5,
      resonanceDb: 3.0,
      resonanceHz: 3200,
      noiseSuppression: 0.3,
    },
  },
  'female-deep': {
    id: 'female-deep',
    label: 'Female Deep',
    description: 'Lower, chest-forward female register. Subtlest transformation.',
    params: {
      pitchSemitones: 3.5,
      formantRatio: 1.09,
      brightnessDb: -2.5,
      resonanceDb: 2.5,
      resonanceHz: 1200,
      noiseSuppression: 0.4,
    },
  },
  'female-clear': {
    id: 'female-clear',
    label: 'Female Clear',
    description: 'Articulate and present — tuned for intelligibility on calls.',
    params: {
      pitchSemitones: 6.0,
      formantRatio: 1.2,
      brightnessDb: 2.0,
      resonanceDb: 4.0,
      resonanceHz: 3000,
      noiseSuppression: 0.5,
    },
  },
};

export const VOICE_PRESET_LIST: VoicePreset[] = Object.values(VOICE_PRESETS);

export const DEFAULT_VOICE_PRESET: VoicePresetId = 'female-natural';
export const DEFAULT_INTENSITY = 0.8;

export function isVoicePresetId(value: unknown): value is VoicePresetId {
  return typeof value === 'string' && value in VOICE_PRESETS;
}

/**
 * Scale a preset by `intensity`, interpolating every parameter from its
 * neutral/no-op value towards the preset value. intensity=0 is a true bypass,
 * intensity=1 is the full preset.
 */
export function resolveVoiceParams(
  presetId: VoicePresetId,
  intensity: number,
  overrides: Partial<Omit<VoiceParams, 'intensity'>> = {},
): VoiceParams {
  const t = clamp(intensity, 0, 1);
  const base = { ...VOICE_PRESETS[presetId].params, ...overrides };
  return {
    // Neutral values: 0 st, 1.0x formant, 0 dB gains.
    pitchSemitones: base.pitchSemitones * t,
    formantRatio: 1 + (base.formantRatio - 1) * t,
    brightnessDb: base.brightnessDb * t,
    resonanceDb: base.resonanceDb * t,
    resonanceHz: base.resonanceHz,
    noiseSuppression: base.noiseSuppression * t,
    intensity: t,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

export function ratioToSemitones(ratio: number): number {
  return 12 * Math.log2(ratio);
}
