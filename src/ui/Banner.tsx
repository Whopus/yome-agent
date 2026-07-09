import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getVersion } from '../config.js';

const LOGO = `
\u2588\u2588    \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588    \u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588
 \u2588\u2588  \u2588\u2588    \u2588\u2588     \u2588\u2588   \u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588   \u2588\u2588
  \u2588\u2588\u2588\u2588     \u2588\u2588     \u2588\u2588   \u2588\u2588 \u2588\u2588\u2588\u2588 \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588
   \u2588\u2588      \u2588\u2588     \u2588\u2588   \u2588\u2588  \u2588\u2588  \u2588\u2588   \u2588\u2588
   \u2588\u2588      \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588      \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588
`.trim();

const LOGO_LINES = LOGO.split('\n');
// All logo lines are padded to the same visual width by the source
// glyph art; `█` (U+2588) is a single-cell character so .length is
// already the column width.
const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => l.length));

function centerPad(totalWidth: number, contentWidth: number): string {
  return ' '.repeat(Math.max(0, Math.floor((totalWidth - contentWidth) / 2)));
}

// Banner is rendered inside Ink's `<Static>`, which writes its children
// directly to scrollback (bypassing Yoga's flex layout) on the first
// commit and never redraws. That means:
//   - We can't rely on `alignItems="center"` — do manual leading padding.
//   - We don't need a resize listener — scrollback is frozen.
// BUT: we do need to read the real terminal width at the moment Ink
// mounts, not at module-load time. Module load often fires before
// Ink has fully taken over stdout (notably under `bun --watch` and
// when booted inside a pipe wrapper), so `process.stdout.columns`
// can read 0 / undefined and we fall back to 80 — and the logo ends
// up visibly left-justified in every real terminal. `useStdout()`
// gives us Ink's view of stdout, which is populated by the time
// render runs.
export const Banner = React.memo(function Banner() {
  const { stdout } = useStdout();
  const termWidth = stdout.columns ?? process.stdout.columns ?? 80;

  const padStr = useMemo(() => centerPad(termWidth, LOGO_WIDTH), [termWidth]);
  const version = getVersion();
  const versionPad = useMemo(
    () => centerPad(termWidth, `v${version}`.length),
    [termWidth, version],
  );

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {LOGO_LINES.map((line, i) => (
        <Text key={i} bold>{padStr}{line}</Text>
      ))}
      <Text dimColor>{versionPad}v{version}</Text>
    </Box>
  );
});
