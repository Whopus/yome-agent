// UnifiedSkillsPicker — TUI for `/skills` slash command.
//
// Lists every skill the agent knows about, regardless of system:
//   - prompt skills: SKILL.md files under .yome/skills (Claude Code FORMAT,
//                    but yome paths only — we don't read ~/.claude)
//   - hub skills:    yome-skill.json packages installed via `yome skill install`
//
// The kind column lets the user immediately see what they're toggling.
// Common actions (enable/disable) work uniformly; uninstall is hub-only
// because removing a SKILL.md should be left to the user's editor.

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UnifiedSkill } from '../yomeSkills/unified.js';
import { originLabel } from '../yomeSkills/unified.js';
import { PickerKeyHint } from './PickerKeyHint.js';

interface UnifiedSkillsPickerProps {
  skills: UnifiedSkill[];
  onToggle: (skill: UnifiedSkill) => void;
  onUninstall: (skill: UnifiedSkill) => void;
  onAdd: () => void;
  onClose: () => void;
}

export function UnifiedSkillsPicker({
  skills,
  onToggle,
  onUninstall,
  onAdd,
  onClose,
}: UnifiedSkillsPickerProps) {
  const [cursor, setCursor] = useState(0);
  const focused = skills[cursor];

  const maxNameLen = useMemo(
    () => (skills.length > 0 ? Math.max(...skills.map((s) => s.name.length)) : 8),
    [skills],
  );
  const maxKindLen = useMemo(
    () => (skills.length > 0 ? Math.max(...skills.map((s) => originLabel(s).length)) : 4),
    [skills],
  );

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose();
      return;
    }
    if (input === 'a') {
      onAdd();
      return;
    }
    if (input === 'u' && focused && focused.kind === 'hub') {
      onUninstall(focused);
      return;
    }
    if (skills.length === 0) return;
    if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : skills.length - 1));
    else if (key.downArrow) setCursor((c) => (c < skills.length - 1 ? c + 1 : 0));
    else if (key.return || input === ' ') {
      if (focused) onToggle(focused);
    }
  });

  const promptCount = skills.filter((s) => s.kind === 'prompt').length;
  const hubCount = skills.filter((s) => s.kind === 'hub').length;

  // Fixed column widths derived from longest cell content. Pointer slot,
  // toggle slot, and the gap between them are constants so every row
  // (focused or not) lines up exactly. The detail block under a focused
  // row reuses the same prefix indent so it visually nests under the name
  // column rather than floating at a magic offset.
  const POINTER_W = 2;   // '>' + space
  const TOGGLE_W = 2;    // '●' + space
  const GAP_W = 2;       // gutter before the name column
  const PREFIX_W = POINTER_W + TOGGLE_W + GAP_W; // 6 — detail indent
  const nameColW = maxNameLen + 2;
  const kindColW = maxKindLen + 2;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} paddingY={0} width="100%">
      {/* Header */}
      <Box>
        <Text bold color="#E87B35">Skills</Text>
        <Text dimColor>{'  '}{'\u2014'}{'  '}{hubCount} hub  ·  {promptCount} prompt</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{'\u2500'.repeat(60)}</Text>
      </Box>

      {/* Empty state */}
      {skills.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>No skills installed yet.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Try one of:</Text>
            <Text dimColor>  · /plugins                              open the hub marketplace</Text>
            <Text dimColor>  · ~/.yome/skills/&lt;name&gt;/SKILL.md       add a prompt skill (user)</Text>
            <Text dimColor>  · ./.yome/skills/&lt;name&gt;/SKILL.md       add a prompt skill (project)</Text>
          </Box>
        </Box>
      )}

      {/* List */}
      {skills.map((s, i) => {
        const isFocused = i === cursor;
        const toggle = s.enabled ? '\u25CF' : '\u25CB';

        return (
          <Box key={s.id} flexDirection="column">
            <Box>
              <Box width={POINTER_W} flexShrink={0}>
                <Text color={isFocused ? '#E87B35' : undefined} bold={isFocused}>
                  {isFocused ? '>' : ' '}
                </Text>
              </Box>
              <Box width={TOGGLE_W} flexShrink={0}>
                <Text color="#E87B35">{toggle}</Text>
              </Box>
              <Box width={GAP_W} flexShrink={0}>
                <Text> </Text>
              </Box>
              <Box width={nameColW} flexShrink={0}>
                <Text bold color={isFocused ? '#E87B35' : undefined} wrap="truncate-end">
                  {s.name}
                </Text>
              </Box>
              <Box width={kindColW} flexShrink={0}>
                <Text dimColor wrap="truncate-end">{originLabel(s)}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">{s.description}</Text>
              </Box>
            </Box>

            {isFocused && (
              <Box marginLeft={PREFIX_W} marginTop={0} marginBottom={1} flexDirection="column">
                {s.kind === 'hub' && (
                  <>
                    <Box>
                      <Box width={9} flexShrink={0}><Text dimColor>slug</Text></Box>
                      <Text dimColor wrap="truncate-end">{s.slug}  ·  v{s.version}  ·  {s.domain}</Text>
                    </Box>
                    {s.source && (
                      <Box>
                        <Box width={9} flexShrink={0}><Text dimColor>source</Text></Box>
                        <Text dimColor wrap="truncate-end">{s.source}</Text>
                      </Box>
                    )}
                    {s.allowedCapabilities && s.allowedCapabilities.length > 0 && (
                      <Box>
                        <Box width={9} flexShrink={0}><Text dimColor>caps</Text></Box>
                        <Text dimColor wrap="truncate-end">{s.allowedCapabilities.join(', ')}</Text>
                      </Box>
                    )}
                  </>
                )}
                {s.kind === 'prompt' && (
                  <Box>
                    <Box width={9} flexShrink={0}><Text dimColor>file</Text></Box>
                    <Text dimColor wrap="truncate-end">{s.installedAt}/SKILL.md</Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        );
      })}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'\u2500'.repeat(60)}</Text>
      </Box>
      <PickerKeyHint
        hints={[
          { keys: '\u2191\u2193', label: 'nav' },
          { keys: 'Space', label: 'toggle' },
          { keys: 'a', label: 'add' },
          ...(focused?.kind === 'hub' ? [{ keys: 'u', label: 'uninstall' }] : []),
          { keys: 'Esc', label: 'close' },
        ]}
      />
    </Box>
  );
}
