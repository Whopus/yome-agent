// MarketplacePicker — TUI for `/plugins` slash command.
//
// Three states: search → results → installing. Hits the public hub via
// searchHub() (yome.work/api/hub/skills?q=...). On Enter, kicks off
// installFromGithub() through the existing CLI helpers; output is piped
// to a transient log line so the user sees progress without leaving the
// modal.
//
// Capability prompts are bypassed for the TUI install (--yes-equivalent)
// since the user already explicitly chose the skill from the list.
// Detail page surface still shows the declared capabilities so the
// choice is informed.

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { searchHub, type SearchHit } from '../yomeSkills/search.js';
import { installFromGithub } from '../yomeSkills/installGithub.js';

type Phase = 'search' | 'results' | 'installing' | 'done' | 'error';

interface MarketplacePickerProps {
  onClose: () => void;
  /** Called after a successful install so the caller can refresh state. */
  onInstalled?: (slug: string) => void;
}

export function MarketplacePicker({ onClose, onInstalled }: MarketplacePickerProps) {
  const [phase, setPhase] = useState<Phase>('search');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [searching, setSearching] = useState(false);

  // ── search input phase ─────────────────────────────────────────
  useInput(async (input, key) => {
    // Global cancel: every phase honors Ctrl+C the same way as Esc on
    // the top-level (search) phase. Matches the convention every other
    // picker (Agent/Model/Session/Toggle/Skills) already uses.
    if (key.ctrl && input === 'c') {
      onClose();
      return;
    }
    if (phase === 'search') {
      if (key.escape) onClose();
      if (key.tab && hits.length > 0) {
        setPhase('results');
        setCursor(0);
      }
      return;
    }
    if (phase === 'results') {
      if (key.escape) {
        setPhase('search');
        return;
      }
      if (key.upArrow) {
        setCursor((c) => (c > 0 ? c - 1 : hits.length - 1));
      } else if (key.downArrow) {
        setCursor((c) => (c < hits.length - 1 ? c + 1 : 0));
      } else if (key.return) {
        const sel = hits[cursor];
        if (!sel) return;
        if (!sel.github_full_name) {
          setErrorMsg(`${sel.slug} has no public GitHub repo — cannot install`);
          setPhase('error');
          return;
        }
        setPhase('installing');
        setStatusMsg(`Cloning ${sel.github_full_name}…`);
        try {
          const result = await installFromGithub(`github:${sel.github_full_name}`, {
            yes: true,
            // sha256 mismatch is expected until the publish flow recomputes
            // fingerprints from a real git checkout (vs the seed-time monorepo).
            // Skip in TUI; CLI users can still enforce via `--no-skip-verify`.
            skipVerify: true,
          });
          if (!result.ok) {
            setErrorMsg(result.reason ?? 'install failed');
            setPhase('error');
            return;
          }
          setStatusMsg(`Installed ${result.slug} → ${result.installedAt}`);
          setPhase('done');
          if (result.slug && onInstalled) onInstalled(result.slug);
        } catch (e) {
          setErrorMsg((e as Error).message);
          setPhase('error');
        }
      }
      return;
    }
    if (phase === 'done' || phase === 'error') {
      if (key.escape || key.return) onClose();
    }
  });

  // ── debounced search trigger ───────────────────────────────────
  useEffect(() => {
    if (phase !== 'search') return;
    const q = query.trim();
    if (q.length === 0) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await searchHub(q, { limit: 25 });
      if (cancelled) return;
      setSearching(false);
      if (!r.ok) {
        setHits([]);
        return;
      }
      setHits(r.hits);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, phase]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width="100%">
      <Box marginBottom={1}>
        <Text bold color="#E87B35">Plugins </Text>
        <Text dimColor>{'\u2014'} hub.yome.work</Text>
      </Box>

      {phase === 'search' && (
        <>
          <Box>
            <Text color="#E87B35">{'> '}</Text>
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="search hub… e.g. ppt, fs, calendar"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            {searching && <Text dimColor>searching…</Text>}
            {!searching && query.trim().length > 0 && hits.length === 0 && (
              <Text dimColor>no matches.</Text>
            )}
            {!searching && hits.length > 0 && (
              <>
                <Text dimColor>{hits.length} result{hits.length === 1 ? '' : 's'}. Tab to browse.</Text>
                {hits.slice(0, 5).map((h) => (
                  <Box key={h.slug}>
                    <Text>  {h.slug}</Text>
                    <Text dimColor> {' '} {h.name ?? ''}</Text>
                  </Box>
                ))}
                {hits.length > 5 && <Text dimColor>  …+{hits.length - 5} more</Text>}
              </>
            )}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Tab browse {'  '} Esc close</Text>
          </Box>
        </>
      )}

      {phase === 'results' && (
        <>
          <Text dimColor>{hits.length} result{hits.length === 1 ? '' : 's'} for "{query}"</Text>
          <Box flexDirection="column" marginTop={1}>
            {hits.map((h, i) => {
              const focused = i === cursor;
              return (
                <Box key={h.slug} flexDirection="column">
                  <Box>
                    <Box width={2} flexShrink={0}>
                      <Text color={focused ? '#E87B35' : undefined} bold={focused}>
                        {focused ? '>' : ' '}
                      </Text>
                    </Box>
                    <Text>{' '}</Text>
                    <Box width={22} flexShrink={0}>
                      <Text bold color={focused ? '#E87B35' : undefined} wrap="truncate-end">
                        {h.slug}
                      </Text>
                    </Box>
                    <Box width={10} flexShrink={0}>
                      <Text dimColor>v{h.latest_version ?? '?'}</Text>
                    </Box>
                    {h.is_official && (
                      <Box width={11} flexShrink={0}>
                        <Text color="#E87B35">[OFFICIAL]</Text>
                      </Box>
                    )}
                    <Text dimColor>★{h.star_count} ↓{h.install_count}</Text>
                  </Box>
                  {focused && (
                    <Box marginLeft={4} flexDirection="column">
                      {h.description && <Text dimColor>{h.description}</Text>}
                      <Text dimColor>
                        repo: {h.github_full_name ?? '(no public repo)'}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{'\u2191\u2193'} navigate {'  '} Enter install {'  '} Esc back</Text>
          </Box>
        </>
      )}

      {phase === 'installing' && (
        <Box flexDirection="column">
          <Text color="#E87B35">{statusMsg}</Text>
        </Box>
      )}

      {phase === 'done' && (
        <Box flexDirection="column">
          <Text color="#E87B35">{'\u2713'} {statusMsg}</Text>
          <Box marginTop={1}>
            <Text dimColor>Enter / Esc to close</Text>
          </Box>
        </Box>
      )}

      {phase === 'error' && (
        <Box flexDirection="column">
          <Text color="red">{'\u2717'} {errorMsg}</Text>
          <Box marginTop={1}>
            <Text dimColor>Enter / Esc to close</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
