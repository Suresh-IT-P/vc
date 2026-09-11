import type { VoiceConverterType } from '@sonder/shared';
import { AIVoiceConverter } from './AIVoiceConverter';
import { DSPVoiceConverter } from './DSPVoiceConverter';
import { DisabledVoiceConverter } from './DisabledVoiceConverter';
import {
  VoiceEngineError,
  isVoiceEngineSupported,
  type VoiceConverter,
  type VoiceConverterOptions,
} from './VoiceConverter';

/**
 * The only place in the app that knows which concrete engines exist.
 *
 *   const converter = VoiceConverterFactory.create({
 *     type: 'dsp',
 *     preset: 'female-natural',
 *   });
 */
export const VoiceConverterFactory = {
  create(options: VoiceConverterOptions): VoiceConverter {
    switch (options.type) {
      case 'dsp':
        return new DSPVoiceConverter(options);
      case 'ai':
        // Constructing it is allowed; initialize() is what refuses. That keeps
        // the failure at a point where there is a UI to report it in.
        return new AIVoiceConverter(options);
      case 'disabled':
        return new DisabledVoiceConverter();
      default: {
        const exhaustive: never = options.type;
        throw new VoiceEngineError(
          'ENGINE_UNAVAILABLE',
          `Unknown voice engine "${String(exhaustive)}".`,
        );
      }
    }
  },

  /** Engines a user is actually allowed to pick, with honest labels. */
  availableTypes(): Array<{
    type: VoiceConverterType;
    label: string;
    description: string;
    available: boolean;
  }> {
    const supported = isVoiceEngineSupported();
    return [
      {
        type: 'dsp',
        label: 'Real-time DSP',
        description:
          'Pitch and formant conversion running entirely in your browser. No audio is uploaded.',
        available: supported,
      },
      {
        type: 'disabled',
        label: 'Off',
        description: 'Send your microphone through untouched.',
        available: true,
      },
    ];
  },
};

export type { VoiceConverter, VoiceConverterOptions };
