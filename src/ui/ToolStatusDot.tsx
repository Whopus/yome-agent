// Smooth transition between the spinning braille indicator (tool in
// progress) and the static "done" dot. Without this, MessageList flips
// from a mid-spin braille glyph directly to `⏺` / `●` on the same frame,
// which reads as a visual jolt when tools complete one after another.
// We play a short sequence of intermediate glyphs that step down from
// "busy" to "settled" before locking onto the final dot.

import React, { useEffect, useRef, useState } from 'react';
import { Text } from 'ink';
import { useFrame } from './animation.js';

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Step-down sequence: braille dots fade into fuller circles, ending on
// the platform-appropriate done marker. The frames are chosen so each
// successive glyph fills more of the cell, reading as "settling".
const TRANSITION_FRAMES = ['⠿', '◐', '◑', '●'];

const DONE_FRAME = process.platform === 'darwin' ? '\u23FA' : '\u25CF';

interface ToolStatusDotProps {
  done: boolean;
  color?: string;
}

export const ToolStatusDot = React.memo(function ToolStatusDot({
  done,
  color = '#E87B35',
}: ToolStatusDotProps) {
  const frame = useFrame();
  const doneAtRef = useRef<number | null>(null);
  // Step index is derived from frames-since-done; snapshot it here so
  // Ink re-renders when the transition advances one step.
  const [transitionStep, setTransitionStep] = useState(0);

  useEffect(() => {
    if (done && doneAtRef.current === null) {
      doneAtRef.current = frame;
    } else if (!done) {
      doneAtRef.current = null;
      setTransitionStep(0);
    }
  }, [done, frame]);

  if (!done) {
    return <Text color={color}>{SPIN_FRAMES[frame % SPIN_FRAMES.length]}</Text>;
  }

  // Advance the transition step whenever enough frames have elapsed.
  if (doneAtRef.current !== null) {
    const elapsed = frame - doneAtRef.current;
    // 2 frames per transition glyph at FRAME_INTERVAL_MS ~= 80ms, so
    // the whole fade is ~640ms — long enough to read, short enough
    // not to slow down a burst of tool completions.
    const step = Math.min(Math.floor(elapsed / 2), TRANSITION_FRAMES.length - 1);
    if (step !== transitionStep) setTransitionStep(step);
    if (step < TRANSITION_FRAMES.length - 1) {
      return <Text color={color}>{TRANSITION_FRAMES[step]}</Text>;
    }
  }

  return <Text color={color}>{DONE_FRAME}</Text>;
});
