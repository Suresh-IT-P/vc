import type { Config } from 'tailwindcss';

/**
 * Sonder's design tokens.
 *
 * The palette is deliberately its own: a violet-to-fuchsia primary with a teal
 * accent, cool neutrals, and a single "signal" ramp for call quality. It is
 * inspired by modern social UI conventions (soft cards, generous radii, subtle
 * gradients) without copying any specific product's brand colours or assets.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx}',
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      /**
       * Tailwind v3 only allows opacity modifiers that exist in the scale, so
       * `bg-background/72` is an error by default. The design uses a lot of
       * fine-grained translucency (glass headers, tinted state layers), and
       * every-integer opacity is far more readable at the call site than
       * arbitrary-value brackets everywhere.
       */
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [index, String(index / 100)]),
      ),
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        /** Call-quality and presence signals. */
        signal: {
          excellent: 'hsl(152 62% 45%)',
          good: 'hsl(88 55% 48%)',
          poor: 'hsl(38 92% 52%)',
          critical: 'hsl(0 78% 58%)',
        },
        online: 'hsl(152 62% 45%)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 10px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        'brand-gradient':
          'linear-gradient(135deg, hsl(266 85% 58%) 0%, hsl(322 82% 58%) 55%, hsl(28 92% 60%) 100%)',
        'brand-gradient-soft':
          'linear-gradient(135deg, hsl(266 85% 58% / 0.14) 0%, hsl(322 82% 58% / 0.14) 100%)',
        'ring-gradient':
          'conic-gradient(from 180deg, hsl(266 85% 58%), hsl(322 82% 58%), hsl(28 92% 60%), hsl(266 85% 58%))',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        /** Incoming-call avatar pulse. */
        'call-pulse': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.55' },
          '50%': { transform: 'scale(1.18)', opacity: '0' },
        },
        /** Typing indicator dots. */
        'typing-bounce': {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.45' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'level-bar': {
          '0%, 100%': { transform: 'scaleY(0.3)' },
          '50%': { transform: 'scaleY(1)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-right': 'slide-in-right 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        'call-pulse': 'call-pulse 2s ease-out infinite',
        'typing-bounce': 'typing-bounce 1.2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
      },
      boxShadow: {
        card: '0 1px 2px hsl(240 10% 10% / 0.04), 0 8px 24px -12px hsl(240 10% 10% / 0.12)',
        lifted: '0 2px 4px hsl(240 10% 10% / 0.06), 0 18px 48px -18px hsl(240 10% 10% / 0.24)',
        glow: '0 0 0 1px hsl(266 85% 58% / 0.35), 0 8px 32px -8px hsl(266 85% 58% / 0.45)',
      },
      screens: {
        xs: '420px',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
