/**
 * Chart palette derived from the brand gradient. Used by every workspace
 * summary widget so a single token bump (here + tailwind.config.ts) restains
 * every chart consistently. Recharts can't render a `linear-gradient(...)`
 * directly - solids are baked in here, gradient stops live in <defs> inside
 * each chart component.
 */
export const CHART_COLORS = {
  purple: '#7B6FE8',
  magenta: '#E040FB',
  orange: '#F4845F',
  blue: '#5B7CE8',
  teal: '#22C5C5',
  ink: '#1A1A2E',
  muted: '#888888',
  line: '#E8E8F0',
  bgSubtle: '#FBF6FA',
} as const;

/** 7-step ordered palette for categorical buckets (status / pipeline). */
export const CATEGORICAL_PALETTE = [
  CHART_COLORS.purple,
  CHART_COLORS.blue,
  CHART_COLORS.magenta,
  CHART_COLORS.teal,
  CHART_COLORS.orange,
  '#A35CF0',
  '#C24EF5',
] as const;
