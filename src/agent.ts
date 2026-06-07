import { buildSystemPrompt } from './context.js';
import { getAnthropicTools, executeTool, registerTool, setPermissionContext, setAskPermissionHandler, getPermissionContext, type AskPermissionResult } from './tools/index.js';
import { loadAllSkills } from './skills/index.js';
import { createLoopRegistry } from './loops/index.js';
import { createAgentTool, clearAgentCache, getAllAgents } from './subagent/index.js';
import { initializePermissionContext, addRuleToContext } from './permissions/loader.js';
import type { ToolPermissionContext, PermissionMode, PermissionBehavior, PermissionRuleSource } from './permissions/types.js';
import type { Skill } from './skills/index.js';
import type { AgentDefinition } from './subagent/index.js';
import type { AgentMessage, ContentBlock, ImageBlock } from './types.js';
import type { YomeConfig, ModelEntry } from './config.js';
import { modelEntryToConfig } from './config.js';
import type { AgentLoopCallbacks } from './loops/index.js';
import type { PastedImage } from './utils/imagePaste.js';
import { createSessionId, appendMessage, loadSessionMessages, setSessionTitle } from './sessions.js';
import { trimMessageHistory } from './llm.js';

export interface AgentCallbacks extends AgentLoopCallbacks {
  onLoopChanged?: (name: string) => void;
  onAskPermission?: (toolName: string, message: string, input: Record<string, unknown>) => Promise<AskPermissionResult>;
}

export class Agent {
  private config: YomeConfig;
  private messages: AgentMessage[] = [];
  private systemPrompt: string;
  private skills: Skill[] = [];
  /**
   * Cached skill list with includeDisabled=true. We re-read SKILL.md files
   * only when explicitly invalidated (resetContext / reloadSkills /
   * skill toggle picker reopens). Previously every call to getSkills() hit
   * the filesystem — and it gets called on every render of the slash menu,
   * the unified picker, and the system prompt rebuild. After ~50 turns
   * that adds up to thousands of redundant readdirSync calls.
   */
  private cachedSkillsAll: Skill[] | null = null;
  private loopRegistry = createLoopRegistry();
  private currentLoopName = 'simple';
  private permissionContext: ToolPermissionContext;
  private sessionId: string;

  constructor(config: YomeConfig) {
    this.config = config;
    this.systemPrompt = buildSystemPrompt();
    this.skills = loadAllSkills();
    registerTool(createAgentTool(config));
    this.permissionContext = initializePermissionContext();
    setPermissionContext(this.permissionContext);
    this.sessionId = createSessionId();
  }

  /** Drop the cached skill list so the next getSkills() call re-reads from disk. */
  invalidateSkillsCache(): void {
    this.cachedSkillsAll = null;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPermissionContext(): ToolPermissionContext {
    return this.permissionContext;
  }

  getConfig(): YomeConfig {
    return this.config;
  }

  switchModel(entry: ModelEntry): void {
    this.config = modelEntryToConfig(entry);
  }

  switchPermissionMode(mode: PermissionMode): void {
    this.permissionContext = { ...this.permissionContext, mode };
    setPermissionContext(this.permissionContext);
  }

  /**
   * Append a rule to the live in-memory permission context AND update the
   * tools subsystem so subsequent invocations see it without restarting.
   *
   * `source: 'session'` — never persisted, lives only for this Agent instance.
   * `source: 'userSettings'` — caller is responsible for also writing to disk
   *   (via `addPermissionRuleToUserSettings`); this just mirrors the rule into
   *   memory so the current session benefits immediately.
   */
  addPermissionRule(
    ruleString: string,
    behavior: PermissionBehavior,
    source: PermissionRuleSource = 'session',
  ): void {
    this.permissionContext = addRuleToContext(this.permissionContext, ruleString, behavior, source);
    setPermissionContext(this.permissionContext);
  }

  resetContext(): void {
    this.messages = [];
    this.systemPrompt = buildSystemPrompt();
    this.skills = loadAllSkills();
    this.cachedSkillsAll = null;
    clearAgentCache();
    registerTool(createAgentTool(this.config));
    this.sessionId = createSessionId();
  }

  restoreSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.messages = loadSessionMessages(sessionId);
    this.systemPrompt = buildSystemPrompt();
    this.skills = loadAllSkills();
    this.cachedSkillsAll = null;
    clearAgentCache();
    registerTool(createAgentTool(this.config));
  }

  getMessages(): AgentMessage[] {
    return this.messages;
  }

  persistMessage(message: AgentMessage): void {
    appendMessage(this.sessionId, message);
  }

  persistTitle(title: string): void {
    setSessionTitle(this.sessionId, title);
  }

  getSkills(): Skill[] {
    if (!this.cachedSkillsAll) {
      this.cachedSkillsAll = loadAllSkills(true);
    }
    return this.cachedSkillsAll;
  }

  getAgents(): AgentDefinition[] {
    return getAllAgents();
  }

  reloadSkills(): void {
    this.skills = loadAllSkills();
    this.cachedSkillsAll = null;
    this.systemPrompt = buildSystemPrompt();
    clearAgentCache();
    registerTool(createAgentTool(this.config));
  }

  getCurrentLoopName(): string {
    return this.currentLoopName;
  }

  getAvailableLoops(): { name: string; description: string }[] {
    return this.loopRegistry.list().map((l) => ({ name: l.name, description: l.description }));
  }

  switchLoop(name: string): boolean {
    const loop = this.loopRegistry.get(name);
    if (!loop) return false;
    this.currentLoopName = name;
    return true;
  }

  private parseSkillInvocation(input: string): { skill: Skill; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const spaceIdx = trimmed.indexOf(' ');
    const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return null;
    return { skill, args };
  }

  async run(userMessage: string, callbacks: AgentCallbacks, images?: PastedImage[]): Promise<void> {
    if (callbacks.onAskPermission) {
      setAskPermissionHandler(callbacks.onAskPermission);
    }

    // Handle skill invocation
    const skillInvocation = this.parseSkillInvocation(userMessage);
    let effectiveMessage = userMessage;
    if (skillInvocation) {
      const { skill, args } = skillInvocation;
      effectiveMessage = `[Skill: /${skill.name}]\n\n${skill.getPrompt(args)}`;
    }

    // Build user input: plain string or content blocks with images
    let userInput: string | ContentBlock[];
    if (images && images.length > 0) {
      const blocks: ContentBlock[] = images.map((img): ImageBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      }));
      blocks.push({ type: 'text', text: effectiveMessage });
      userInput = blocks;
    } else {
      userInput = effectiveMessage;
    }

    const loop = this.loopRegistry.get(this.currentLoopName) ?? this.loopRegistry.default();
    const tools = getAnthropicTools();

    try {
      await loop.run(userInput, {
        config: this.config,
        systemPrompt: this.systemPrompt,
        messages: this.messages,
        tools,
        executeTool,
      }, callbacks);
    } finally {
      this.messages = trimMessageHistory(this.messages);
    }
  }
}
