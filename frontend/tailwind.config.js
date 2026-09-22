export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          50:  '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
        brand: {
          100: '#d1fae5',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          // brand-600/700 carry white labels: 4.77:1 and 4.82:1.
          // brand-500 (#10b981) measures 2.54:1 against white and must never be a fill behind text.
          600: '#168163',
          700: '#047857',
          900: '#064e3b',
          950: '#022c22',
        },
      },
      // Fixed layer scale: no arbitrary z values anywhere.
      zIndex: {
        rail: '10',
        menu: '40',
        dialog: '50',
        confirm: '60',
        overlay: '100',
      },
      // Keep in step with src/lib/breakpoints.ts — asserted by test/design-tokens.test.ts.
      screens: {
        xs: '600px',
        md2: '720px',
        nav: '800px',
        wide: '900px',
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '1rem' }],
        '3xs': ['10px', { lineHeight: '0.875rem' }],
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Cascadia Code"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      transitionDuration: {
        DEFAULT: 'var(--motion-duration-micro)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--motion-ease-move)',
      },
    },
  },
  plugins: [],
}
