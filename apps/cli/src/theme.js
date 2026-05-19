// Brand palette mapped to chalk styled helpers.
// Source: BioHash announcement card v11 colors.
import chalk from 'chalk';

// Hex colors from the announcement card
export const COLORS = {
  canvas: '#F1EDE0',
  headline: '#0E1F3C',
  muted: '#6E6C5E',
  body: '#3A3A36',

  // Terminal palette
  termBg: '#0A0F1E',
  termText: '#D9D6CC',
  termAmber: '#FAC775',
  termMint: '#9FE1CB',
  termRed: '#F09595',
  termDim: '#888880',

  // Traffic lights
  trafficRed: '#E24B4A',
  trafficYellow: '#EF9F27',
  trafficGreen: '#5DCAA5',
};

// chalk hex helpers (chalk.hex requires truecolor terminal)
export const c = {
  // primary
  cream: chalk.hex(COLORS.termText),
  amber: chalk.hex(COLORS.termAmber),
  mint: chalk.hex(COLORS.termMint),
  red: chalk.hex(COLORS.termRed),
  dim: chalk.hex(COLORS.termDim),
  muted: chalk.hex(COLORS.muted),

  // logo + status
  logo: chalk.hex(COLORS.termAmber).bold,
  logoShadow: chalk.hex('#8A6D3F'),
  live: chalk.hex(COLORS.trafficGreen),

  // emphasis
  number: chalk.hex(COLORS.termAmber).bold,
  label: chalk.hex(COLORS.termDim),
  ok: chalk.hex(COLORS.trafficGreen),
  fail: chalk.hex(COLORS.trafficRed),

  // headers
  caps: chalk.hex(COLORS.muted),
};
