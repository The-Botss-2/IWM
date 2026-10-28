import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Theme-aware tokens - resolve at runtime from CSS variables defined in
        // globals.css. The `:root` block carries the light-mode triple and
        // `html.dark` swaps each variable, so a single `bg-bg-app` class
        // automatically follows whichever theme the user picked. The
        // `<alpha-value>` placeholder lets utilities like `bg-bg-app/80` keep
        // working.
        bg: {
          app: 'rgb(var(--bg-app) / <alpha-value>)',
          surface: 'rgb(var(--bg-surface) / <alpha-value>)',
          subtle: 'rgb(var(--bg-subtle) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          disabled: 'rgb(var(--ink-disabled) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        brand: {
          // Legacy scale (kept so existing classes keep compiling).
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: '#E9DEF8',
          200: '#D3BCF1',
          300: '#B68BE5',
          400: '#9A6FE8',
          500: '#7B6FE8',
          600: '#6655D4',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          purple: '#7B6FE8',
          magenta: '#E040FB',
          orange: '#F4845F',
          blue: '#5B7CE8',
          teal: '#22C5C5',
        },
        accent: {
          meeting: '#7B6FE8',
          call: '#22C5C5',
          task: '#E040FB',
          document: '#F4845F',
          email: '#5B7CE8',
        },
        // Soft background tints for status chips, icons and banners. Theme
        // aware, unlike the raw `bg-[#FEF2F3]`-style hexes they replace.
        tint: {
          error: 'rgb(var(--tint-error) / <alpha-value>)',
          warning: 'rgb(var(--tint-warning) / <alpha-value>)',
          info: 'rgb(var(--tint-info) / <alpha-value>)',
        },
        state: {
          active: '#22C5C5',
          pending: '#888888',
          inactive: '#1A1A2E',
          warning: '#F4845F',
          error: '#E5484D',
          draft: '#888888',
          success: '#22C5C5',
        },
      },
      fontFamily: {
        sans: [
          'var(--font-poppins)',
          'Poppins',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      fontSize: {
        xs: ['12px', { lineHeight: '1.5' }],
        sm: ['13px', { lineHeight: '1.5' }],
        base: ['14px', { lineHeight: '1.5' }],
        lg: ['16px', { lineHeight: '1.5' }],
        xl: ['18px', { lineHeight: '1.4' }],
        '2xl': ['24px', { lineHeight: '1.25' }],
        '3xl': ['32px', { lineHeight: '1.2' }],
      },
      borderRadius: {
        none: '0',
        sm: '4px',
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '24px',
        full: '9999px',
      },
      boxShadow: {
        // Soft brand-aligned elevation tokens - see UI brief §5/§6/§13.
        soft: '0 4px 20px rgba(0,0,0,0.06)',
        'soft-lg': '0 8px 28px rgba(0,0,0,0.10)',
        pill: '0 4px 20px rgba(0,0,0,0.08)',
        drawer: '-8px 0 32px rgba(0,0,0,0.10)',
        popover: '0 8px 28px rgba(0,0,0,0.12)',
        fab: '0 8px 24px rgba(123,111,232,0.32)',
        'fab-hover': '0 12px 32px rgba(123,111,232,0.45)',
        focus: '0 0 0 3px rgba(123,111,232,0.15)',
      },
      backgroundImage: {
        // Reads CSS variable from globals.css so /settings/appearance can swap
        // the brand gradient at runtime without rebuilding Tailwind.
        'brand-gradient': 'var(--brand-gradient)',
        'brand-gradient-soft': 'var(--brand-gradient-soft)',
        'fallback-avatar': 'linear-gradient(135deg, #F4845F 0%, #E040FB 100%)',
        'status-success-text': 'linear-gradient(90deg, #5B7CE8 0%, #22C5C5 100%)',
      },
      keyframes: {
        'gradient-pulse': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.06)' },
        },
        'gradient-spin': {
          to: { transform: 'rotate(360deg)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-text': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'gradient-pulse': 'gradient-pulse 1.5s ease-in-out infinite',
        'gradient-spin': 'gradient-spin 0.8s linear infinite',
        shimmer: 'shimmer 1.4s ease-in-out infinite',
        'pulse-text': 'pulse-text 1.6s ease-in-out infinite',
        'fade-in': 'fade-in 200ms ease-out both',
      },
      transitionDuration: {
        DEFAULT: '200ms',
      },
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  plugins: [require('tailwindcss-animate')],
};

export default config;
