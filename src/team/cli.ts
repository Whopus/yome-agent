import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateDeviceId, currentPlatform } from '../mesh/device-id.js';
import { readAuthState } from '../yomeSkills/auth.js';
import { installFromHubTarball } from '../yomeSkills/installFromHubTarball.js';
import { listInstalled } from '../yomeSkills/list.js';
import { getHubBase } from '../yomeSkills/login.js';

export interface TeamCliFlags {
  json?: boolean;
  org?: string;
}

interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'member';
  billingOwner: boolean;
  workflowBuilder: boolean;
}

interface TeamDeployment {
  assignment_id: string;
  item_id: string;
  kind: 'skill' | 'workflow' | 'pack';
  source: 'hub' | 'internal';
  slug: string;
  title: string;
  description: string | null;
  version: string | null;
  mode: 'required' | 'recommended' | 'optional' | 'blocked';
  version_policy: 'locked' | 'auto_patch' | 'manual';
  target_kind: 'org' | 'group' | 'user' | 'device' | 'platform';
  target_id: string;
  status: string;
  risk_level: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
  body?: Record<string, unknown> | null;
}

interface TeamListResponse {
  ok: boolean;
  teams?: TeamInfo[];
  error?: string;
}

interface TeamDeploymentsResponse {
  ok: boolean;
  team?: TeamInfo;
  teams?: TeamInfo[];
  deployments?: TeamDeployment[];
  error?: string;
}

interface TeamSyncEvent {
  assignmentId: string;
  itemId: string;
  kind: TeamDeployment['kind'];
  slug: string;
  mode: TeamDeployment['mode'];
  version: string | null;
  status: 'installed' | 'updated' | 'up_to_date' | 'skipped' | 'blocked' | 'failed';
  detail: string;
  durationMs: number;
}

interface TeamSyncResponse {
  ok: boolean;
  inserted?: number;
  error?: string;
}

interface TeamBillingAccount {
  org_id: string;
  plan: 'team';
  billing_status: 'trialing' | 'active' | 'past_due' | 'canceled';
  billing_email: string | null;
  seat_limit: number;
  included_tokens: number;
  token_soft_limit: number;
  current_period_start: string;
  current_period_end: string;
}

interface TeamUsageSummary {
  periodStart: string;
  periodEnd: string;
  seats: { active: number; limit: number };
  tokens: {
    input: number;
    output: number;
    total: number;
    weighted: number;
    included: number;
    softLimit: number;
  };
  runs: number;
  durationMs: number;
  estimatedCostCents: number;
}

interface TeamBillingResponse {
  ok: boolean;
  team?: TeamInfo;
  teams?: TeamInfo[];
  billing?: TeamBillingAccount;
  usage?: TeamUsageSummary;
  error?: string;
}

interface RequestResult<T> {
  status: number;
  body: T;
}

export async function runTeamSubcommand(args: string[], flags: TeamCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'list':
    case 'ls':
    case 'orgs':
      return await doList(flags);
    case 'deployments':
    case 'deployment':
    case 'assigned':
      return await doDeployments(args.slice(1), flags);
    case 'sync':
      return await doSync(args.slice(1), flags);
    case 'billing':
    case 'usage':
      return await doBilling(args.slice(1), flags);
    case undefined:
    case 'help':
    case '--help':
      printTeamHelp();
      return 0;
    default:
      console.error(`Unknown subcommand: yome team ${sub}`);
      printTeamHelp();
      return 2;
  }
}

async function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<RequestResult<T> | { error: string }> {
  const auth = readAuthState();
  if (!auth?.yome_token) return { error: 'Not logged in. Run `yome login` first.' };

  const hubBase = getHubBase().replace(/\/+$/, '');
  let resp: Response;
  try {
    resp = await fetch(`${hubBase}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.yome_token}`,
        'User-Agent': `yome-cli/0.x team ${currentPlatform()}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    return { error: `Network error contacting hub: ${(err as Error).message}` };
  }

  try {
    return { status: resp.status, body: await resp.json() as T };
  } catch {
    return { error: `Hub returned non-JSON (HTTP ${resp.status}).` };
  }
}

async function doList(flags: TeamCliFlags): Promise<number> {
  const result = await requestJson<TeamListResponse>('/api/cli/team/orgs');
  if ('error' in result) {
    console.error(`Error: ${result.error}`);
    return 1;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    return result.body.ok ? 0 : 1;
  }
  if (!result.body.ok) {
    console.error(`Error: ${result.body.error ?? `HTTP ${result.status}`}`);
    return 1;
  }

  const teams = result.body.teams ?? [];
  if (teams.length === 0) {
    console.log('No teams. Create one from the Yome dashboard.');
    return 0;
  }
  printTeams(teams);
  return 0;
}

async function doDeployments(args: string[], flags: TeamCliFlags): Promise<number> {
  const org = flags.org ?? args[0] ?? '';
  const params = new URLSearchParams({
    deviceId: getOrCreateDeviceId(),
    platform: currentPlatform(),
  });
  if (org) params.set('org', org);

  const result = await requestJson<TeamDeploymentsResponse>(`/api/cli/team/deployments?${params}`);
  if ('error' in result) {
    console.error(`Error: ${result.error}`);
    return 1;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    return result.body.ok ? 0 : 1;
  }
  if (!result.body.ok) {
    console.error(`Error: ${result.body.error ?? `HTTP ${result.status}`}`);
    if (result.body.teams?.length) {
      console.error('Teams:');
      printTeams(result.body.teams, true);
    }
    return result.status === 400 ? 2 : 1;
  }

  const team = result.body.team;
  const deployments = result.body.deployments ?? [];
  if (team) {
    console.log(`Team: ${team.name} (${team.slug})`);
  }
  if (deployments.length === 0) {
    console.log('No deployments apply to this CLI device.');
    return 0;
  }
  printDeployments(deployments);
  return 0;
}

async function doSync(args: string[], flags: TeamCliFlags): Promise<number> {
  const org = flags.org ?? args[0] ?? '';
  const deviceId = getOrCreateDeviceId();
  const platform = currentPlatform();
  const params = new URLSearchParams({ deviceId, platform });
  if (org) params.set('org', org);

  const result = await requestJson<TeamDeploymentsResponse>(`/api/cli/team/deployments?${params}`);
  if ('error' in result) {
    console.error(`Error: ${result.error}`);
    return 1;
  }
  if (!result.body.ok) {
    if (flags.json) process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    else console.error(`Error: ${result.body.error ?? `HTTP ${result.status}`}`);
    return result.status === 400 ? 2 : 1;
  }

  const team = result.body.team;
  const deployments = result.body.deployments ?? [];
  const events = await syncDeployments(deployments, team);

  let report: TeamSyncResponse | null = null;
  if (team && events.length > 0) {
    const reported = await requestJson<TeamSyncResponse>('/api/cli/team/deployment-events', {
      method: 'POST',
      body: { org: team.id, deviceId, platform, events },
    });
    if ('error' in reported) {
      report = { ok: false, error: reported.error };
    } else {
      report = reported.body;
    }
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, team, events, report }, null, 2) + '\n');
    return events.some((event) => event.status === 'failed') ? 1 : 0;
  }

  if (team) console.log(`Team: ${team.name} (${team.slug})`);
  if (events.length === 0) {
    console.log('No deployments apply to this CLI device.');
    return 0;
  }
  printSyncEvents(events);
  if (report && !report.ok) {
    console.error(`Warning: sync status was not reported: ${report.error ?? 'unknown error'}`);
  }
  return events.some((event) => event.status === 'failed') ? 1 : 0;
}

async function doBilling(args: string[], flags: TeamCliFlags): Promise<number> {
  const org = flags.org ?? args[0] ?? '';
  const params = new URLSearchParams();
  if (org) params.set('org', org);

  const query = params.toString();
  const result = await requestJson<TeamBillingResponse>(`/api/cli/team/billing${query ? `?${query}` : ''}`);
  if ('error' in result) {
    console.error(`Error: ${result.error}`);
    return 1;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    return result.body.ok ? 0 : 1;
  }
  if (!result.body.ok || !result.body.team || !result.body.billing || !result.body.usage) {
    console.error(`Error: ${result.body.error ?? `HTTP ${result.status}`}`);
    if (result.body.teams?.length) {
      console.error('Teams:');
      printTeams(result.body.teams, true);
    }
    return result.status === 400 ? 2 : 1;
  }

  printBilling(result.body.team, result.body.billing, result.body.usage);
  return 0;
}

async function syncDeployments(deployments: TeamDeployment[], team?: TeamInfo): Promise<TeamSyncEvent[]> {
  const installedBySlug = new Map(listInstalled().map((skill) => [skill.slug, skill]));
  const events: TeamSyncEvent[] = [];

  for (const deployment of deployments) {
    const startedAt = Date.now();
    const base = {
      assignmentId: deployment.assignment_id,
      itemId: deployment.item_id,
      kind: deployment.kind,
      slug: deployment.slug,
      mode: deployment.mode,
      version: deployment.version,
    };

    if (deployment.mode === 'blocked') {
      events.push({
        ...base,
        status: 'blocked',
        detail: installedBySlug.has(deployment.slug) ? 'installed locally but blocked by team' : 'blocked by team',
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    if (deployment.mode === 'optional') {
      events.push({
        ...base,
        status: 'skipped',
        detail: 'optional deployment',
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    if (deployment.kind !== 'skill') {
      const result = syncStructuredDeployment(deployment, team);
      events.push({
        ...base,
        status: result.status,
        detail: result.detail,
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    if (deployment.source !== 'hub') {
      const result = syncInternalSkillDeployment(deployment, team);
      if (result.status === 'installed' || result.status === 'updated' || result.status === 'up_to_date') {
        installedBySlug.set(deployment.slug, {
          slug: deployment.slug,
          domain: '',
          version: deployment.version ?? '1.0.0',
          name: deployment.title,
          description: deployment.description ?? undefined,
          installedAt: result.installedAt,
          manifest: {
            slug: deployment.slug,
            domain: '',
            version: deployment.version ?? '1.0.0',
            name: deployment.title,
          },
        });
      }
      events.push({
        ...base,
        status: result.status,
        detail: result.detail,
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    const before = installedBySlug.get(deployment.slug);
    if (before && deployment.version && before.version === deployment.version) {
      events.push({
        ...base,
        status: 'up_to_date',
        detail: `already installed at ${before.version}`,
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    const result = await installFromHubTarball(deployment.slug, {
      version: deployment.version ?? undefined,
      force: Boolean(before),
      yes: true,
    });
    if (!result.ok) {
      events.push({
        ...base,
        status: 'failed',
        detail: result.reason ?? 'install failed',
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    const afterVersion = result.resolvedVersion ?? deployment.version ?? before?.version ?? 'latest';
    installedBySlug.set(deployment.slug, {
      slug: deployment.slug,
      domain: before?.domain ?? '',
      version: afterVersion,
      name: deployment.title,
      description: deployment.description ?? undefined,
      installedAt: result.installedAt ?? before?.installedAt ?? '',
      manifest: before?.manifest ?? {
        slug: deployment.slug,
        domain: '',
        version: afterVersion,
        name: deployment.title,
      },
    });
    events.push({
      ...base,
      status: before ? (before.version === afterVersion ? 'up_to_date' : 'updated') : 'installed',
      detail: result.installedAt ? `installed at ${result.installedAt}` : 'installed',
      durationMs: Date.now() - startedAt,
    });
  }

  return events;
}

function syncStructuredDeployment(
  deployment: TeamDeployment,
  team?: TeamInfo,
): { status: TeamSyncEvent['status']; detail: string } {
  const folder = deployment.kind === 'workflow' ? 'workflows' : 'packs';
  const target = join(teamRoot(team), folder, `${safeFileName(deployment.slug)}.json`);
  const body = deployment.body ?? {};
  const payload = {
    kind: deployment.kind,
    source: deployment.source,
    slug: deployment.slug,
    title: deployment.title,
    description: deployment.description,
    version: deployment.version,
    mode: deployment.mode,
    versionPolicy: deployment.version_policy,
    capabilities: deployment.capabilities,
    metadata: deployment.metadata ?? {},
    body,
  };
  return writeHashedJson(target, payload);
}

function syncInternalSkillDeployment(
  deployment: TeamDeployment,
  team?: TeamInfo,
): { status: TeamSyncEvent['status']; detail: string; installedAt: string } {
  const parsed = parseSkillSlug(deployment.slug, team);
  const installedAt = join(homedir(), '.yome', 'skills', parsed.owner, parsed.name);
  const body = deployment.body ?? {};
  const manifestInput = objectValue(body.manifest) ?? objectValue(body.yomeSkill) ?? body;
  const manifest = {
    slug: deployment.slug,
    name: deployment.title,
    version: deployment.version ?? stringValue(manifestInput.version) ?? '1.0.0',
    description: deployment.description ?? stringValue(manifestInput.description) ?? undefined,
    capabilities: deployment.capabilities,
    ...manifestInput,
  };
  const payload = {
    manifest,
    teamDeployment: {
      team: team ? { id: team.id, slug: team.slug, name: team.name } : null,
      assignmentId: deployment.assignment_id,
      itemId: deployment.item_id,
      mode: deployment.mode,
      versionPolicy: deployment.version_policy,
      syncedAt: new Date().toISOString(),
    },
    body,
  };

  mkdirSync(installedAt, { recursive: true });
  const result = writeHashedJson(join(installedAt, 'team-deployment.json'), payload);
  writeFileSync(join(installedAt, 'yome-skill.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (!existsSync(join(installedAt, 'README.md'))) {
    writeFileSync(join(installedAt, 'README.md'), `# ${deployment.title}\n\nTeam private skill: ${deployment.slug}\n`, 'utf8');
  }
  return { ...result, installedAt };
}

function writeHashedJson(target: string, payload: Record<string, unknown>): { status: TeamSyncEvent['status']; detail: string } {
  const hash = contentHash(payload);
  const metaPath = `${target}.meta.json`;
  const previous = readJson(metaPath);
  const existed = existsSync(target);
  if (previous?.hash === hash && existed) {
    return { status: 'up_to_date', detail: `already synced at ${target}` };
  }

  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(metaPath, JSON.stringify({ hash, syncedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return { status: existed ? 'updated' : 'installed', detail: `${existed ? 'updated' : 'installed'} at ${target}` };
}

function teamRoot(team?: TeamInfo): string {
  return join(homedir(), '.yome', 'team', safeFileName(team?.slug ?? team?.id ?? 'default'));
}

function safeFileName(value: string): string {
  return value.replace(/^@/, '').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) || 'item';
}

function parseSkillSlug(slug: string, team?: TeamInfo): { owner: string; name: string } {
  const trimmed = slug.trim();
  const match = trimmed.match(/^@?([^/]+)\/(.+)$/);
  if (match) return { owner: safeFileName(match[1]), name: safeFileName(match[2]) };
  return { owner: safeFileName(team?.slug ?? 'team'), name: safeFileName(trimmed) };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? {}), 'utf8').digest('hex');
}

function printTeams(teams: TeamInfo[], stderr = false): void {
  const out = stderr ? process.stderr : process.stdout;
  const nameW = Math.max(4, ...teams.map((team) => team.name.length));
  const slugW = Math.max(4, ...teams.map((team) => team.slug.length));
  const pad = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - value.length));
  out.write(`  ${pad('NAME', nameW)}  ${pad('SLUG', slugW)}  ROLE\n`);
  for (const team of teams) {
    out.write(`  ${pad(team.name, nameW)}  ${pad(team.slug, slugW)}  ${team.role}\n`);
  }
}

function printDeployments(deployments: TeamDeployment[]): void {
  const kindW = Math.max(4, ...deployments.map((deployment) => deployment.kind.length));
  const modeW = Math.max(4, ...deployments.map((deployment) => deployment.mode.length));
  const slugW = Math.max(4, ...deployments.map((deployment) => deployment.slug.length));
  const targetW = Math.max(6, ...deployments.map((deployment) => targetText(deployment).length));
  const pad = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - value.length));
  console.log(`  ${pad('KIND', kindW)}  ${pad('MODE', modeW)}  ${pad('SLUG', slugW)}  VERSION  ${pad('TARGET', targetW)}  TITLE`);
  for (const deployment of deployments) {
    console.log(
      `  ${pad(deployment.kind, kindW)}  ` +
      `${pad(deployment.mode, modeW)}  ` +
      `${pad(deployment.slug, slugW)}  ` +
      `${pad(deployment.version ?? 'latest', 7)}  ` +
      `${pad(targetText(deployment), targetW)}  ` +
      `${deployment.title}`,
    );
  }
}

function printSyncEvents(events: TeamSyncEvent[]): void {
  const statusW = Math.max(6, ...events.map((event) => event.status.length));
  const slugW = Math.max(4, ...events.map((event) => event.slug.length));
  const pad = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - value.length));
  console.log(`  ${pad('STATUS', statusW)}  ${pad('SLUG', slugW)}  MODE         DETAIL`);
  for (const event of events) {
    console.log(`  ${pad(event.status, statusW)}  ${pad(event.slug, slugW)}  ${pad(event.mode, 11)}  ${event.detail}`);
  }
}

function printBilling(team: TeamInfo, billing: TeamBillingAccount, usage: TeamUsageSummary): void {
  console.log(`Team: ${team.name} (${team.slug})`);
  console.log(`Status: ${billing.billing_status}`);
  console.log(`Period: ${shortDate(usage.periodStart)} - ${shortDate(usage.periodEnd)}`);
  console.log(`Seats: ${usage.seats.active}/${usage.seats.limit}`);
  console.log(`Weighted tokens: ${formatNumber(usage.tokens.weighted)} / ${formatNumber(usage.tokens.softLimit)}`);
  console.log(`Raw tokens: ${formatNumber(usage.tokens.total)} (${formatNumber(usage.tokens.input)} in, ${formatNumber(usage.tokens.output)} out)`);
  console.log(`Runs: ${formatNumber(usage.runs)}`);
  console.log(`Estimated cost: ${formatDollars(usage.estimatedCostCents)}`);
}

function targetText(deployment: TeamDeployment): string {
  if (deployment.target_kind === 'org') return 'team';
  if (deployment.target_kind === 'platform') return `platform:${deployment.target_id}`;
  return `${deployment.target_kind}:${deployment.target_id.slice(0, 8)}`;
}

function shortDate(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatDollars(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function printTeamHelp(): void {
  console.log(`Usage:
  yome team list
  yome team deployments [team-slug-or-id] [--json]
  yome team sync [team-slug-or-id] [--json]
  yome team billing [team-slug-or-id] [--json]

Examples:
  yome team list
  yome team deployments acme
  yome team sync acme
  yome team billing acme
  yome team deployments --org acme --json`);
}
