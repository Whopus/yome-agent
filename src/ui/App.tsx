import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { Agent } from '../agent.js';
import { getVersion, loadModelEntries } from '../config.js';
import type { ModelEntry } from '../config.js';
import { isSkillDisabled, isAgentDisabled, toggleSkill, toggleAgent } from '../toggleState.js';
import { addPermissionRuleToUserSettings, extractBashRulePrefix } from '../permissions/loader.js';
import { MessageList, getToolLabel, getToolDetail } from './MessageList.js';
import { InputBar } from './InputBar.js';
import { theme } from './theme.js';
import type { SlashCommand } from './InputBar.js';
import { Banner } from './Banner.js';
import { AgentPicker } from './AgentPicker.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { PermissionPrompt, type PermissionChoice } from './PermissionPrompt.js';
import { AskUserPrompt } from './AskUserPrompt.js';
import { TodoPanel } from './TodoPanel.js';
import type { AskPermissionResult } from '../tools/index.js';
import { setAskUserHandler, type AskUserQuestion, type AskUserResult } from '../tools/index.js';
import { getTodos, setTodosChangeHandler, clearTodos, type TodoItem } from '../state/todos.js';
import { TogglePicker } from './TogglePicker.js';
import { UnifiedSkillsPicker } from './UnifiedSkillsPicker.js';
import { MarketplacePicker } from './MarketplacePicker.js';
import { listAllUnified, type UnifiedSkill } from '../yomeSkills/unified.js';
import { uninstallBySlug } from '../yomeSkills/uninstall.js';
import { setSkillEnabled } from '../yomeSkills/enable.js';
import { listSessions } from '../sessions.js';
import type { ToggleItem } from './TogglePicker.js';
import type { Message } from './MessageList.js';
import type { YomeConfig } from '../config.js';
import type { PermissionMode } from '../permissions/types.js';
import type { PastedImage } from '../utils/imagePaste.js';
import { getImageFromClipboard } from '../utils/imagePaste.js';
import type { ImageBlock } from '../types.js';
import { useThrottledStream } from './useThrottledStream.js';
import { ShimmerText } from './ShimmerText.js';

interface AppProps {
  config: YomeConfig;
}

// Monotonic id source for messages. Required by <Static> so React can
// keep stable keys across renders even when older messages mutate
// (e.g. a tool_start flipping `done`). Lives at module scope so it's
// stable across re-mounts within the same process.
let _msgIdSeq = 0;
const nextMsgId = (): number => ++_msgIdSeq;

const UI_TOOL_RESULT_LIMIT = 12_000;
const UI_DIFF_LINE_LIMIT = 80;
const UI_SUMMARY_PREFIX = '@@YOME_UI_SUMMARY:';

function compactToolResultForUi(name: string, result: string): string {
  if (result.startsWith('[YOME_PERMISSION_DENIED]')) return result;

  // These tools feed the model but do not render content in the TUI.
  if (name === 'Read' || name === 'LS' || name === 'Grep' || name === 'Glob') {
    return '';
  }

  if (name === 'Bash') {
    if (result.startsWith('Exit code:')) {
      return result.split('\n')[0] ?? result.slice(0, 200);
    }
    const lineCount = result.split('\n').length;
    return lineCount > 3 ? `${UI_SUMMARY_PREFIX}(${lineCount} lines of output)` : '';
  }

  if (result.startsWith('@@FILE:')) {
    const lines = result.split('\n');
    const truncatedByLines = lines.length > UI_DIFF_LINE_LIMIT;
    let compact = (truncatedByLines ? lines.slice(0, UI_DIFF_LINE_LIMIT) : lines).join('\n');
    if (compact.length > UI_TOOL_RESULT_LIMIT) {
      compact = compact.slice(0, UI_TOOL_RESULT_LIMIT) + `\n[Diff output capped at ${UI_TOOL_RESULT_LIMIT} chars]`;
    } else if (truncatedByLines) {
      compact += `\n[Diff output capped at ${UI_DIFF_LINE_LIMIT} lines]`;
    }
    return compact;
  }

  if (result.length > UI_TOOL_RESULT_LIMIT) {
    return result.slice(0, UI_TOOL_RESULT_LIMIT) + `\n[Tool output capped at ${UI_TOOL_RESULT_LIMIT} chars for display]`;
  }
  return result;
}

export function App({ config }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const stream = useThrottledStream();
  const [inputValue, setInputValue] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showSkillsPicker, setShowSkillsPicker] = useState(false);
  const [showAgentsPicker, setShowAgentsPicker] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [unifiedSkillsCache, setUnifiedSkillsCache] = useState<UnifiedSkill[]>([]);
  const [currentModelDisplay, setCurrentModelDisplay] = useState<string | undefined>(config.model);
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string;
    message: string;
    detail: string;
    suggestedRule: string;
    resolve: (result: AskPermissionResult) => void;
  } | null>(null);
  const pendingPermissionRef = useRef(pendingPermission);
  pendingPermissionRef.current = pendingPermission;
  const [pendingAskUser, setPendingAskUser] = useState<{
    questions: AskUserQuestion[];
    resolve: (result: AskUserResult) => void;
  } | null>(null);
  const [todos, setLocalTodos] = useState<TodoItem[]>(() => getTodos());
  const [pickerVersion, setPickerVersion] = useState(0);
  // Bumped whenever the conversation resets (`/new`, session restore).
  // MessageList forwards this to <Static key=...> so Ink remounts the
  // append-only scrollback buffer instead of leaving the old chat
  // visible above the new one.
  const [resetEpoch, setResetEpoch] = useState(0);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [agent] = useState(() => new Agent(config));
  const [loopName, setLoopName] = useState(() => agent.getCurrentLoopName());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => agent.getPermissionContext().mode);
  const [pendingImages, setPendingImages] = useState<PastedImage[]>([]);
  const isFirstMessage = useRef(true);
  const version = getVersion();

  const handleSubmit = useCallback(
    async (text: string) => {
      if ((!text.trim() && pendingImages.length === 0) || isRunning) return;
      const prompt = text.trim();
      setInputValue('');

      // /new — reset context and start fresh
      if (prompt === '/new') {
        agent.resetContext();
        setMessages([]);
        stream.reset();
        setUsage({ inputTokens: 0, outputTokens: 0 });
        isFirstMessage.current = true;
        // Wipe todos too — a new session shouldn't inherit the previous
        // task list. setTodos triggers the change handler, which keeps
        // the panel in sync.
        clearTodos();
        // Wipe the terminal scrollback so the previous chat actually
        // disappears. Ink's <Static> is append-only — without clearing
        // the screen + bumping resetEpoch (forces a fresh Static
        // instance) the user sees the old session sitting above the new
        // banner, which is exactly the "/new doesn't work" symptom.
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        setResetEpoch((e) => e + 1);
        return;
      }

      // /login — mock login command
      if (prompt === '/login') {
        setMessages((prev) => [
          ...prev,
          { id: nextMsgId(), type: 'text', content: '🔒 Login requested. This is a mock implementation.' },
          { id: nextMsgId(), type: 'text', content: 'Enter your credentials (mock):' },
          { id: nextMsgId(), type: 'text', content: '• Username: `user@example.com`' },
          { id: nextMsgId(), type: 'text', content: '• Password: `••••••••`' },
          { id: nextMsgId(), type: 'text', content: '✅ Login successful! You are now authenticated.' },
        ]);
        return;
      }

      // /sessions — open session picker
      if (prompt === '/sessions') {
        setShowSessionPicker(true);
        return;
      }

      // /skills — unified picker (prompt skills + hub skills together)
      if (prompt === '/skills') {
        setUnifiedSkillsCache(listAllUnified(true));
        setShowSkillsPicker(true);
        setPickerVersion((v) => v + 1);
        return;
      }

      // /plugins — open the hub marketplace (search + install)
      if (prompt === '/plugins' || prompt === '/marketplace') {
        setShowMarketplace(true);
        return;
      }

      // /skill <subcommand> — inline non-interactive CLI subcommands.
      // Lets users install/uninstall/list without leaving the chat.
      // Examples:
      //   /skill install github:owner/repo
      //   /skill list
      //   /skill uninstall @yome/ppt
      if (prompt.startsWith('/skill ') || prompt === '/skill') {
        const argsText = prompt.replace(/^\/skill\s*/, '').trim();
        if (argsText.length === 0) {
          setMessages((prev) => [...prev, {
            id: nextMsgId(),
            type: 'text',
            content: 'Usage: `/skill <subcommand>` — try `install github:owner/repo`, `list`, `uninstall <slug>`, or open `/skills` for the picker.',
          }]);
          return;
        }
        const argv = argsText.split(/\s+/);
        const { runSkillSubcommand } = await import('../yomeSkills/cli.js');
        // Capture stdout/stderr so the chat shows what would have printed.
        const captured: string[] = [];
        const origLog = console.log;
        const origErr = console.error;
        console.log = (...a: unknown[]) => captured.push(a.map(String).join(' '));
        console.error = (...a: unknown[]) => captured.push(a.map(String).join(' '));
        try {
          await runSkillSubcommand(argv, { yes: true, skipVerify: true });
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
        const out = captured.join('\n').trim() || '(no output)';
        setMessages((prev) => [...prev, { id: nextMsgId(), type: 'text', content: '```\n' + out + '\n```' }]);
        // Refresh the cache so a follow-up /skills sees the result.
        setUnifiedSkillsCache(listAllUnified(true));
        return;
      }

      // /subagents — interactive toggle picker
      if (prompt === '/subagents') {
        setShowAgentsPicker(true);
        setPickerVersion((v) => v + 1);
        return;
      }

      // /agent — open interactive picker
      if (prompt === '/agent') {
        setShowAgentPicker(true);
        return;
      }

      // /model — open model picker
      if (prompt === '/model') {
        setShowModelPicker(true);
        return;
      }

      const images = [...pendingImages];
      setPendingImages([]);

      const imageLabel = images.length > 0
        ? ` [${images.length} image${images.length > 1 ? 's' : ''}]`
        : '';
      setMessages((prev) => [...prev, { id: nextMsgId(), type: 'user', content: (prompt || '(image)') + imageLabel }]);
      stream.reset();
      setIsRunning(true);

      // Persist user message to session
      agent.persistMessage({ role: 'user', content: prompt || '(image)' });
      if (isFirstMessage.current) {
        agent.persistTitle(prompt.slice(0, 100) || '(image)');
        isFirstMessage.current = false;
      }

      // Local accumulator for the current assistant turn — written to from
      // onTextDelta, snapshotted into a real Message on tool boundaries
      // and onDone. We track it via a closure variable rather than the
      // throttled stream's buffer so persisting + flushing stay accurate
      // even when tokens arrive faster than the throttle interval.
      let currentText = '';

      const commitStreamingText = () => {
        if (!currentText) return;
        const text = currentText;
        currentText = '';
        // Flush the throttled buffer first so we don't see a stale tail
        // flicker after the message gets pushed.
        stream.reset();
        setMessages((prev) => [...prev, { id: nextMsgId(), type: 'text', content: text }]);
      };

      await agent.run(prompt || 'What is in this image?', {
        async onAskPermission(toolName, message, input): Promise<AskPermissionResult> {
          const detail = toolName === 'Bash'
            ? (input.command as string) ?? ''
            : (input.file_path as string) ?? '';
          // Compute the most useful "always allow" rule string for this call.
          // - Bash: derive command prefix like `Bash(npm run:*)` so the rule
          //   only matches similar commands instead of all shell access.
          // - Other tools: fall back to plain tool name so a single approval
          //   silences future prompts for that tool.
          let suggestedRule = toolName;
          if (toolName === 'Bash') {
            const prefix = extractBashRulePrefix(detail);
            suggestedRule = prefix ? `Bash(${prefix})` : `Bash(${detail})`;
          }
          return new Promise<AskPermissionResult>((resolve) => {
            setPendingPermission({ toolName, message, detail, suggestedRule, resolve });
          });
        },
        onTextDelta(delta) {
          currentText += delta;
          stream.append(delta);
        },
        onToolUse(name, input) {
          commitStreamingText();
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              type: 'tool_start',
              content: name,
              toolName: name,
              toolLabel: getToolLabel(name),
              toolSummary: getToolDetail(name, input),
            },
          ]);
        },
        onToolResult(name, result) {
          const uiResult = compactToolResultForUi(name, result);
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].type === 'tool_start' && updated[i].toolName === name && !updated[i].done) {
                updated[i] = { ...updated[i], done: true };
                break;
              }
            }
            return [...updated, { id: nextMsgId(), type: 'tool_result', content: uiResult, toolName: name }];
          });
        },
        onDone(u) {
          if (currentText) {
            const text = currentText;
            currentText = '';
            setMessages((prev) => [...prev, { id: nextMsgId(), type: 'text', content: text }]);
            agent.persistMessage({ role: 'assistant', content: text });
          }
          stream.reset();
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + u.inputTokens,
            outputTokens: prev.outputTokens + u.outputTokens,
          }));
          setIsRunning(false);
        },
        onError(err) {
          setMessages((prev) => [...prev, { id: nextMsgId(), type: 'error', content: err.message }]);
          stream.reset();
          setIsRunning(false);
        },
      }, images.length > 0 ? images : undefined);
    },
    [agent, isRunning, pendingImages, stream],
  );

  const handleAgentSelect = useCallback(
    (name: string) => {
      agent.switchLoop(name);
      setLoopName(name);
      setShowAgentPicker(false);
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), type: 'text', content: `Switched to **${name}** agent loop.` },
      ]);
    },
    [agent],
  );

  const handleAgentCancel = useCallback(() => {
    setShowAgentPicker(false);
  }, []);

  const handleModelSelect = useCallback(
    (entry: ModelEntry) => {
      agent.switchModel(entry);
      setCurrentModelDisplay(entry.displayName);
      setShowModelPicker(false);
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), type: 'text', content: `Switched to model **${entry.displayName}** (${entry.model}).` },
      ]);
    },
    [agent],
  );

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      agent.restoreSession(sessionId);
      const restored = agent.getMessages();
      const uiMessages: Message[] = [];
      for (const msg of restored) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join(' ');
          uiMessages.push({ id: nextMsgId(), type: 'user', content: text });
        } else if (msg.role === 'assistant') {
          const text = typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join(' ');
          if (text) uiMessages.push({ id: nextMsgId(), type: 'text', content: text });
        }
      }
      setMessages(uiMessages);
      stream.reset();
      setUsage({ inputTokens: 0, outputTokens: 0 });
      isFirstMessage.current = false;
      setShowSessionPicker(false);
      // Same scrollback-clearing dance as /new — see comment there.
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setResetEpoch((e) => e + 1);
    },
    [agent, stream],
  );

  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, []);

  const handlePermissionResolve = useCallback((choice: PermissionChoice) => {
    const pending = pendingPermissionRef.current;
    if (!pending) return;
    const { toolName, resolve } = pending;
    switch (choice.kind) {
      case 'allow_once':
        resolve({ decision: 'allow' });
        break;
      case 'allow_session':
        // In-memory only — no disk write, vanishes on CLI restart.
        agent.addPermissionRule(choice.ruleString, 'allow', 'session');
        resolve({ decision: 'allow' });
        setMessages((prev) => [
          ...prev,
          { id: nextMsgId(), type: 'text', content: `已添加本会话允许规则：\`${choice.ruleString}\`` },
        ]);
        break;
      case 'allow_always':
        // Persist + mirror into memory so the *current* session also benefits
        // (was a bug previously: write went to disk but live ctx wasn't refreshed).
        addPermissionRuleToUserSettings(choice.ruleString, 'allow');
        agent.addPermissionRule(choice.ruleString, 'allow', 'userSettings');
        resolve({ decision: 'allow' });
        setMessages((prev) => [
          ...prev,
          { id: nextMsgId(), type: 'text', content: `已永久允许规则：\`${choice.ruleString}\`（写入 ~/.yome/settings.json）` },
        ]);
        break;
      case 'deny':
        resolve({ decision: 'deny', feedback: choice.feedback });
        break;
    }
    setPendingPermission(null);
  }, [agent]);

  const buildSkillItems = useCallback((): ToggleItem[] => {
    return agent.getSkills().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      enabled: !isSkillDisabled(s.name),
    }));
  }, [agent]);

  const buildAgentItems = useCallback((): ToggleItem[] => {
    return agent.getAgents().map((a) => ({
      name: a.agentType,
      description: a.whenToUse,
      source: a.source,
      enabled: !isAgentDisabled(a.agentType),
      skills: a.skills,
    }));
  }, [agent]);

  const handleSkillToggle = useCallback((name: string) => {
    const nowEnabled = toggleSkill(name);
    setPickerVersion((v) => v + 1);
    const status = nowEnabled ? 'enabled' : 'disabled';
    setMessages((prev) => [...prev, { id: nextMsgId(), type: 'text', content: `Skill **${name}** ${status}.` }]);
  }, []);

  const handleAgentToggle = useCallback((name: string) => {
    const nowEnabled = toggleAgent(name);
    setPickerVersion((v) => v + 1);
    const status = nowEnabled ? 'enabled' : 'disabled';
    setMessages((prev) => [...prev, { id: nextMsgId(), type: 'text', content: `Agent **${name}** ${status}.` }]);
  }, []);

  // ── Unified /skills handlers ──────────────────────────────────
  const refreshUnifiedSkills = useCallback(() => {
    setUnifiedSkillsCache(listAllUnified(true));
    setPickerVersion((v) => v + 1);
  }, []);

  const handleUnifiedToggle = useCallback((s: UnifiedSkill) => {
    if (s.kind === 'prompt') {
      const nowEnabled = toggleSkill(s.name);
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        type: 'text',
        content: `Skill **${s.name}** ${nowEnabled ? 'enabled' : 'disabled'}.`,
      }]);
    } else {
      // hub: enabled = currently enabled; we want the opposite
      const r = setSkillEnabled(s.slug!, !s.enabled);
      if (!r.ok) {
        setMessages((prev) => [...prev, { id: nextMsgId(), type: 'error', content: r.reason ?? 'toggle failed' }]);
        return;
      }
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        type: 'text',
        content: `Hub skill **${s.slug}** ${!s.enabled ? 'enabled' : 'disabled'}.`,
      }]);
    }
    refreshUnifiedSkills();
  }, [refreshUnifiedSkills]);

  const handleUnifiedUninstall = useCallback((s: UnifiedSkill) => {
    if (s.kind !== 'hub' || !s.slug) return;
    const r = uninstallBySlug(s.slug);
    if (!r.ok) {
      setMessages((prev) => [...prev, { id: nextMsgId(), type: 'error', content: r.reason ?? 'uninstall failed' }]);
      return;
    }
    setMessages((prev) => [...prev, { id: nextMsgId(), type: 'text', content: `Removed hub skill **${s.slug}**.` }]);
    refreshUnifiedSkills();
  }, [refreshUnifiedSkills]);

  const handleAddFromMarketplace = useCallback(() => {
    setShowSkillsPicker(false);
    setShowMarketplace(true);
  }, []);

  const handleMarketplaceClose = useCallback(() => {
    setShowMarketplace(false);
    refreshUnifiedSkills();
  }, [refreshUnifiedSkills]);

  const handleMarketplaceInstalled = useCallback((slug: string) => {
    setMessages((prev) => [...prev, {
      id: nextMsgId(),
      type: 'text',
      content: `Installed hub skill **${slug}** from marketplace.`,
    }]);
  }, []);

  useEffect(() => {
    const initialPrompt = (config as any).__initialPrompt;
    if (initialPrompt) handleSubmit(initialPrompt);
  }, []);

  // Wire up the AskUser tool: register a TUI handler that pushes the
  // questions into pendingAskUser state and resolves the promise once
  // the user finishes (or cancels) the AskUserPrompt component.
  useEffect(() => {
    setAskUserHandler((questions) => {
      return new Promise<AskUserResult>((resolve) => {
        setPendingAskUser({ questions, resolve });
      });
    });
    // No teardown — leaving a handler in place across remounts is safe;
    // the closure captures the latest setPendingAskUser via React's
    // stable setState identity.
  }, []);

  // Mirror the session-scope todo store into local React state so the
  // TodoPanel re-renders on every TodoWrite call.
  useEffect(() => {
    setTodosChangeHandler((next) => setLocalTodos(next));
    // Pick up any todos written before this effect attached (cheap; the
    // store's getTodos is just a module-scope read).
    setLocalTodos(getTodos());
  }, []);

  const isPickerOpen = showAgentPicker || showModelPicker || showSkillsPicker || showAgentsPicker || showSessionPicker || showMarketplace || pendingPermission !== null || pendingAskUser !== null;

  const PERMISSION_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];

  const handleImagePaste = useCallback(() => {
    const image = getImageFromClipboard();
    if (image) {
      setPendingImages((prev) => [...prev, image]);
    }
  }, []);

  useInput((input, key) => {
    if (!isPickerOpen && key.ctrl && input === 'c') exit();
    if (!isPickerOpen && !isRunning && key.ctrl && input === 'v') {
      handleImagePaste();
    }
    if (!isPickerOpen && !isRunning && key.shift && key.tab) {
      const idx = PERMISSION_CYCLE.indexOf(permissionMode);
      const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length]!;
      agent.switchPermissionMode(next);
      setPermissionMode(next);
    }
  });

  const slashCommands: SlashCommand[] = React.useMemo(() => {
    const builtIn: SlashCommand[] = [
      { name: 'new', description: 'Start a new conversation (reset context)' },
      { name: 'login', description: 'Mock login command (for demonstration)' },
      { name: 'sessions', description: 'Browse and continue previous sessions' },
      { name: 'model', description: 'Switch model' },
      { name: 'skills', description: 'Manage installed skills (prompt + hub)' },
      { name: 'plugins', description: 'Browse the hub marketplace and install skills' },
      { name: 'skill', description: 'Inline skill subcommand: install / list / uninstall …' },
      { name: 'subagents', description: 'Manage subagents (enable/disable)' },
      { name: 'agent', description: 'Switch agent loop mode' },
    ];
    const skillItems = agent.getSkills()
      .filter((s) => !isSkillDisabled(s.name))
      .map((s) => ({ name: s.name, description: s.description }));
    return [...builtIn, ...skillItems];
  }, [agent, pickerVersion]);

  const totalTokens = usage.inputTokens + usage.outputTokens;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/*
        Banner is rendered INSIDE MessageList's <Static> as its first
        item, so Ink commits it to scrollback right after the user's
        `yome` command line and never moves it again. Real messages
        are appended below it in the same Static stream.
      */}

      {messages.length > 0 && (
        <Box marginBottom={1} marginTop={1}>
          <Text bold color={theme.accent}>{'> '}</Text>
          <Text bold>Yome</Text>
          <Text> </Text>
          {isRunning
            ? <ShimmerText text="streaming" />
            : <Text dimColor>Waiting</Text>}
          {totalTokens > 0 && (
            <Text dimColor> {'\u00B7'} {(totalTokens / 1000).toFixed(1)}k tokens</Text>
          )}
        </Box>
      )}

      <MessageList messages={messages} streamText={stream.displayText} isRunning={isRunning} resetEpoch={resetEpoch} />

      {showAgentPicker && (
        <Box marginTop={1}>
          <AgentPicker
            options={agent.getAvailableLoops().map((l) => ({
              name: l.name,
              description: l.description,
              active: l.name === loopName,
            }))}
            onSelect={handleAgentSelect}
            onCancel={handleAgentCancel}
          />
        </Box>
      )}

      {showSkillsPicker && (
        <Box marginTop={1} width="100%">
          <UnifiedSkillsPicker
            key={`unified-skills-${pickerVersion}`}
            skills={unifiedSkillsCache}
            onToggle={handleUnifiedToggle}
            onUninstall={handleUnifiedUninstall}
            onAdd={handleAddFromMarketplace}
            onClose={() => setShowSkillsPicker(false)}
          />
        </Box>
      )}

      {showMarketplace && (
        <Box marginTop={1} width="100%">
          <MarketplacePicker
            onClose={handleMarketplaceClose}
            onInstalled={handleMarketplaceInstalled}
          />
        </Box>
      )}

      {showModelPicker && (
        <Box marginTop={1}>
          <ModelPicker
            models={loadModelEntries()}
            currentModel={agent.getConfig().model}
            onSelect={handleModelSelect}
            onCancel={handleModelCancel}
          />
        </Box>
      )}

      {showSessionPicker && (
        <Box marginTop={1}>
          <SessionPicker
            sessions={listSessions()}
            onSelect={handleSessionSelect}
            onCancel={handleSessionCancel}
          />
        </Box>
      )}

      {showAgentsPicker && (
        <Box marginTop={1}>
          <TogglePicker
            key={`agents-${pickerVersion}`}
            title="Agents"
            items={buildAgentItems()}
            onToggle={handleAgentToggle}
            onClose={() => setShowAgentsPicker(false)}
            emptyHint={'No agents found.\n\nCreate agents in:\n  ~/.yome/agents/<name>.md  (user)\n  .yome/agents/<name>.md   (project)'}
          />
        </Box>
      )}

      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          message={pendingPermission.message}
          detail={pendingPermission.detail}
          suggestedRule={pendingPermission.suggestedRule}
          onResolve={handlePermissionResolve}
        />
      )}

      {pendingAskUser && (
        <AskUserPrompt
          questions={pendingAskUser.questions}
          onResolve={(result) => {
            pendingAskUser.resolve(result);
            setPendingAskUser(null);
          }}
        />
      )}

      <TodoPanel todos={todos} />

      {!isRunning && !isPickerOpen && (
        <InputBar
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          model={currentModelDisplay}
          loopName={loopName}
          slashCommands={slashCommands}
          permissionMode={permissionMode}
          imageCount={pendingImages.length}
        />
      )}
    </Box>
  );
}
