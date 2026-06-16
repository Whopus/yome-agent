// Central palette for every Ink component in the CLI.
//
// Every hex literal that used to live inline in a component file (most
// notably the brand orange #E87B35, which was duplicated in >15 places)
// should be sourced from here. Sub-shades and state variants live next
// to their base token so swapping the accent only touches this file.

export const theme = {
  // Primary brand accent. Focused rows, headers, prompt carets, spinners.
  accent: '#E87B35',
  // Active/selected highlight. Currently identical to accent, but split
  // out so future theming can differentiate "focus ring" from "selection".
  focus: '#E87B35',
  // Dim variant of accent (for the small " (active) " tag next to the
  // currently-applied option in pickers).
  accentMuted: '#E87B35',

  // Mode banners on the input bar.
  warning: '#E7BD1F', // acceptEdits — mid-yellow
  danger: '#FF6B6B',  // bypassPermissions — red/coral

  // Status colors for diffs, errors, success indicators.
  success: 'green',
  error: 'red',

  // Muted / disabled. Explicitly named so callers don't guess between
  // `"gray"` and `dimColor` semantics.
  muted: 'gray',

  // Shimmer ramp — sweeps from accent through white and back, used by
  // `ShimmerText`. Centralized so the base color stays in sync with
  // `theme.accent` if either gets retuned.
  shimmerRamp: [
    '#E87B35', // accent base
    '#EC8C4D',
    '#F09D65',
    '#F3AE7D',
    '#F7BF95',
    '#FBD0AD',
    '#FFFFFF', // peak
    '#FBD0AD',
    '#F7BF95',
    '#F3AE7D',
    '#F09D65',
    '#EC8C4D',
  ] as const,
} as const;

export type ThemeColor = typeof theme[keyof typeof theme];
