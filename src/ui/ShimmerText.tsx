// ShimmerText — animated text with a moving gradient highlight.
//
// Each character picks its color based on (frame - charIndex) mod period,
// so a "shine" appears to sweep left → right across the word. The
// gradient palette is a ramp from the brand orange through bright
// yellow to a near-white peak and back, which reads as a soft
// "streaming" highlight in the terminal.
//
// Costs nothing extra in timer overhead — uses the shared frame driver.

import React from 'react';
import { Text } from 'ink';
import { useFrame } from './animation.js';
import { theme } from './theme.js';

// Two-tone ramp: accent → white → accent. Linear interpolation from
// the brand accent to white and back. The peak (#FFFFFF) is the moving
// "spot light" sweeping across the word; everything else is just an
// accent-to-white gradient with no extra hues. The palette is sourced
// from `theme.shimmerRamp` so retuning the brand color flows here
// automatically.
//
// Ink uses chalk under the hood, which supports truecolor in modern
// terminals, so any hex value works.
const RAMP = theme.shimmerRamp;

interface ShimmerTextProps {
  text: string;
  /** How many frames between each character shift. 1 = fastest. */
  speed?: number;
  bold?: boolean;
}

export function ShimmerText({ text, speed = 1, bold = true }: ShimmerTextProps) {
  const frame = useFrame();
  const period = RAMP.length;
  // Slower speed = larger divisor so the spot light moves less per frame.
  const phase = Math.floor(frame / Math.max(1, speed));

  // We render one <Text> per character. That's a few extra nodes but
  // they're tiny and Ink's renderer batches them into one terminal
  // patch via its damage tracker. Memoization elsewhere already makes
  // sure non-shimmering rows don't re-render along with this one.
  return (
    <Text>
      {Array.from(text).map((ch, i) => {
        const idx = ((phase - i) % period + period) % period;
        const color = RAMP[idx]!;
        return (
          <Text key={i} color={color} bold={bold}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}
