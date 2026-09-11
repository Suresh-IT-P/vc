export const APP_NAME = 'Sonder';
export const APP_TAGLINE = 'Talk in your own voice. Or someone else’s.';

/** Typing indicator auto-expires this long after the last keystroke. */
export const TYPING_TIMEOUT_MS = 4000;
/** Client throttles typing:start to at most one per this interval. */
export const TYPING_THROTTLE_MS = 1500;

/** How long a callee's device rings before the call is auto-timed-out. */
export const CALL_RING_TIMEOUT_MS = 45_000;
/** Grace window for an ICE restart before we declare the call failed. */
export const CALL_RECONNECT_GRACE_MS = 30_000;

/** Poll interval for the WebRTC quality sampler. */
export const CALL_STATS_INTERVAL_MS = 2000;

export const MESSAGES_PAGE_SIZE = 40;
export const CALLS_PAGE_SIZE = 30;

/**
 * STFT size for the voice converter, chosen from physics rather than taste.
 *
 * A Hann window's main lobe is 4 FFT bins wide, so to separate the harmonics of
 * a male voice (F0 ~ 85-155 Hz) the window must satisfy 4 * (fs / N) < F0:
 *
 *   N = 1024 @ 48 kHz -> 187 Hz main lobe -> harmonics SMEARED, 21.3 ms latency
 *   N = 2048 @ 48 kHz ->  94 Hz main lobe -> harmonics RESOLVED, 42.7 ms latency
 *
 * At 1024 the source/filter separation degrades badly for exactly the voices
 * this feature exists to convert, so we pay the extra ~21 ms. Total mouth-to-ear
 * then lands around 75-125 ms including network, comfortably inside ITU-T G.114's
 * 150 ms "good quality" budget for one-way voice.
 */
export const VOICE_FFT_SIZE = 2048;
export const VOICE_HOP_SIZE = 512; // 75% overlap

export const AVATAR_FALLBACK_GRADIENTS = [
  'from-violet-500 to-fuchsia-500',
  'from-sky-500 to-indigo-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-blue-500',
] as const;
