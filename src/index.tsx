import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './ui/App.js';
import { resolveConfig, saveStoredConfig, CONFIG_PATH, loadModelEntries, modelEntryToConfig } from './config.js';
import { runSkillSubcommand, runLogin, runLogout, runWhoami } from './yomeSkills/cli.js';
import { runThreadSubcommand } from './threadCli.js';
import { runDaemonSubcommand } from './daemon/index.js';
import { runCronSubcommand } from './daemon/cronCli.js';
import { runTaskById } from './daemon/runTaskEntry.js';
import { runMeshSubcommand } from './commands/mesh.js';
import { runTeamSubcommand } from './team/cli.js';

const cli = meow(
  `
  Usage
    $ yome [prompt]
    $ yome skill <subcommand>
    $ yome team <subcommand>
    $ yome thread <subcommand>
    $ yome mesh <subcommand>

  Team Subcommands
    $ yome team list                         List teams for the logged-in CLI user
    $ yome team deployments [team-slug]      Show team deployments for this device
    $ yome team sync [team-slug]             Install required/recommended hub skills
    $ yome team billing [team-slug]          Show Team seats and usage

  Mesh Subcommands
    $ yome mesh start [--foreground]    Connect this box to Yome Cloud as a mesh device
    $ yome mesh stop                    Stop the background mesh daemon
    $ yome mesh status                  Show mesh daemon status + device id
    $ yome mesh logs [-f]               Print / tail the mesh daemon log
    $ yome mesh info                    Show user + device id + capabilities
    $ yome mesh rename <alias> [desc]   Set this device's display alias

  Skill Subcommands
    $ yome skill install <source>   Install a skill. <source> can be:
                                      - local dir
                                      - github:owner/repo[@ref][#subpath]
                                      - https://github.com/owner/repo
    $ yome skill uninstall <slug>   Uninstall an installed skill (e.g. @yome/ppt)
    $ yome skill list               List installed skills

  Daemon / Cron Subcommands
    $ yome daemon install               Install LaunchAgent (auto-starts on login)
    $ yome daemon start                 Start the daemon in the background
    $ yome daemon status                Show daemon pid + active task count
    $ yome cron add "<prompt>" --at "0 9 * * *"
                                        Schedule an unattended agent task
    $ yome cron list                    List scheduled tasks
    $ yome cron logs <id> -f            Tail audit log for a task

  Thread Subcommands
    $ yome thread list                            List sessions in the current cwd
    $ yome thread share <session-id> --skill=<slug>
                                    Build a redacted case bundle from a session
    $ yome thread submit <bundle-dir> --skill=<slug>
                                    Push an existing bundle as a PR (uses gh CLI)

  Options
    --key, -k       Set API key (saved to ~/.yome/config.json)
    --base-url, -b  Set API base URL (saved to ~/.yome/config.json)
    --model, -m     Set model name
    --provider, -p  API provider: "anthropic" or "openai" (auto-detected from base URL)
    --force         (skill install) Overwrite an existing install
    --verbose       (skill install / thread submit) Print every shelled command
    --skill         (thread share/submit) Skill slug, e.g. @yome/ppt
    --out           (thread share) Output directory (default ~/.yome/shares/...)
    --no-redact     (thread share) Disable default redactor (NOT recommended)
    --submit        (thread share) Open a PR right after building the bundle
    --case-id       (thread share/submit) Override cases/<domain>/<id>/ name
    --dry-run       (thread submit) Prepare commit but skip git push + gh pr create
    --json          Print machine-readable JSON for supported commands
    --org           (team) Team id or slug

  Environment Variables
    YOME_API_KEY    API key
    YOME_BASE_URL   API base URL (default: https://zenmux.ai/api)
    YOME_MODEL      Model name
    YOME_PROVIDER   API provider: "anthropic" or "openai"

  Examples
    $ yome "help me read package.json"
    $ yome skill install ./skills/yome-skill-ppt
    $ yome skill list
    $ yome skill uninstall @yome/ppt
`,
  {
    importMeta: import.meta,
    allowUnknownFlags: true,
    flags: {
      key: { type: 'string', shortFlag: 'k' },
      baseUrl: { type: 'string', shortFlag: 'b' },
      model: { type: 'string', shortFlag: 'm' },
      provider: { type: 'string', shortFlag: 'p' },
      force: { type: 'boolean' },
      verbose: { type: 'boolean' },
      skill: { type: 'string' },
      out: { type: 'string' },
      noRedact: { type: 'boolean' },
      submit: { type: 'boolean' },
      caseId: { type: 'string' },
      dryRun: { type: 'boolean' },
      json: { type: 'boolean' },
      org: { type: 'string' },
      yes: { type: 'boolean', shortFlag: 'y' },
      grant: { type: 'string' },
      revoke: { type: 'string' },
      skipVerify: { type: 'boolean' },
      reason: { type: 'string' },
      replacedBy: { type: 'string' },
      version: { type: 'string' },
      allowDeprecated: { type: 'boolean' },
      // daemon / cron flags
      foreground: { type: 'boolean' },
      follow: { type: 'boolean', shortFlag: 'f' },
      at: { type: 'string' },
      human: { type: 'string' },
      once: { type: 'string' },
      on: { type: 'string' },
      path: { type: 'string' },
      within: { type: 'string' },        // calendar lead time, e.g. "10m"
      titleRegex: { type: 'string' },    // calendar title filter
      calendar: { type: 'string' },      // calendar name filter
      tz: { type: 'string' },
      cwd: { type: 'string' },
      allow: { type: 'string', isMultiple: true },
      deny: { type: 'string', isMultiple: true },
      maxMs: { type: 'string' },
      env: { type: 'string', isMultiple: true },   // KEY=VAL, repeatable
      // mesh flags
      as: { type: 'string' },              // `yome mesh start --as <hostname>`
      hubBase: { type: 'string' },         // dev override for hub base URL
      tui: { type: 'boolean' },            // `yome mesh start --tui` mounts a thin-client TUI
      // login flag
      github: { type: 'boolean' },         // `yome login --github` forces GitHub Device Flow
    },
  },
);

// Subcommand router (kept as plain dispatch — meow doesn't do nested commands).
// If/when we have ≥5 subcommands, switch to citty per spec 11.4 plan.
if (cli.input[0] === 'skill') {
  const exit = await runSkillSubcommand(cli.input.slice(1), {
    force: !!cli.flags.force,
    verbose: !!cli.flags.verbose,
    json: !!cli.flags.json,
    yes: !!cli.flags.yes,
    grant: cli.flags.grant,
    revoke: cli.flags.revoke,
    skipVerify: !!cli.flags.skipVerify,
    reason: cli.flags.reason,
    replacedBy: cli.flags.replacedBy,
    version: cli.flags.version,
    allowDeprecated: !!cli.flags.allowDeprecated,
  });
  process.exit(exit);
}

// Top-level auth commands (`yome login` / `logout` / `whoami`)
if (cli.input[0] === 'login')  { process.exit(await runLogin({ github: !!cli.flags.github })); }
if (cli.input[0] === 'logout') { process.exit(await runLogout()); }
if (cli.input[0] === 'whoami') { process.exit(await runWhoami()); }

if (cli.input[0] === 'thread') {
  const exit = await runThreadSubcommand(cli.input.slice(1), {
    skill: cli.flags.skill,
    out: cli.flags.out,
    noRedact: !!cli.flags.noRedact,
    submit: !!cli.flags.submit,
    caseId: cli.flags.caseId,
    dryRun: !!cli.flags.dryRun,
    verbose: !!cli.flags.verbose,
  });
  process.exit(exit);
}

if (cli.input[0] === 'team') {
  const exit = await runTeamSubcommand(cli.input.slice(1), {
    json: !!cli.flags.json,
    org: typeof cli.flags.org === 'string' ? cli.flags.org : undefined,
  });
  process.exit(exit);
}

// Internal: scheduler spawns `yome __run-task <id>` per fire.
// Not exposed in --help; users go through `yome cron run`.
if (cli.input[0] === '__run-task') {
  const id = cli.input[1];
  if (!id) { console.error('usage: yome __run-task <id>'); process.exit(2); }
  process.exit(await runTaskById(id));
}

if (cli.input[0] === 'daemon') {
  const exit = await runDaemonSubcommand(cli.input.slice(1), {
    foreground: !!cli.flags.foreground,
    follow: !!cli.flags.follow,
  });
  process.exit(exit);
}

if (cli.input[0] === 'mesh') {
  const exit = await runMeshSubcommand(cli.input.slice(1), {
    foreground: !!cli.flags.foreground,
    follow: !!cli.flags.follow,
    as: typeof cli.flags.as === 'string' ? cli.flags.as : undefined,
    hubBase: typeof cli.flags.hubBase === 'string' ? cli.flags.hubBase : undefined,
    tui: !!cli.flags.tui,
  });
  process.exit(exit);
}

if (cli.input[0] === 'cron') {
  const exit = await runCronSubcommand(cli.input.slice(1), {
    at: cli.flags.at,
    human: cli.flags.human,
    once: cli.flags.once,
    on: cli.flags.on,
    path: cli.flags.path,
    within: cli.flags.within,
    titleRegex: cli.flags.titleRegex,
    calendar: cli.flags.calendar,
    tz: cli.flags.tz,
    cwd: cli.flags.cwd,
    allow: cli.flags.allow,
    deny: cli.flags.deny,
    maxMs: cli.flags.maxMs,
    env: cli.flags.env,
    follow: !!cli.flags.follow,
    json: !!cli.flags.json,
  });
  process.exit(exit);
}

if (cli.input[0] === 'doctor') {
  const { runDoctor } = await import('./yomeSkills/doctor.js');
  const report = runDoctor();
  if (cli.flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
  }
  if (report.issues.length > 0) {
    console.log(`\n⚠️  Doctor found ${report.issues.filter((i) => i.level === 'error').length} error(s) and ${report.issues.filter((i) => i.level === 'warning').length} warning(s):`);
    for (const issue of report.issues) {
      const prefix = issue.level === 'error' ? '❌ ERROR' : '⚠️  WARNING';
      const slug = issue.slug ? ` [${issue.slug}]` : '';
      const path = issue.path ? `\n     at ${issue.path}` : '';
      console.log(`  ${prefix}${slug}: ${issue.message}${path}`);
    }
    console.log(`\n💡 Run 'yome skill list' or inspect ~/.yome/skills/ manually.`);
  } else {
    console.log(`✅ Doctor passed: ${report.scanned} skills scanned, no issues found.`);
  }
  process.exit(report.ok ? 0 : 1);
}

// `yome <domain> [action] [args...]` — direct skill invocation through
// the agentic kernel. Same code path the LLM's Bash tool uses, so
// `yome ppt new ~/x.pptx` (terminal) and `Bash({"command":"ppt new ~/x.pptx"})`
// (LLM) end up running identical logic — including --help rendering and
// capability checks.
//
// We rebuild the original argv as a single command line and feed it to
// tryKernel(). meow has already split flags out of cli.input, so we have
// to splice them back in to reconstruct the user's intent.
//
// Routes BEFORE the API-key check because skill calls don't need an LLM key.
const RESERVED_TOP_LEVEL_DOMAINS = new Set([
  'skill', 'login', 'logout', 'whoami', 'doctor', 'thread', 'team', 'daemon', 'cron', 'mesh', '__run-task',
]);
if (
  cli.input.length >= 1 &&
  !RESERVED_TOP_LEVEL_DOMAINS.has(cli.input[0]!) &&
  /^[a-z][a-z0-9_-]*$/.test(cli.input[0]!)
) {
  const { tryKernel } = await import('./skills/runner/kernel.js');
  // Reconstruct the original command line. process.argv[2..] is the
  // simplest source — meow can drop trailing positionals + reorder flags,
  // but argv preserves the user's exact tokens.
  const raw = process.argv.slice(2).filter((a) => {
    // Drop CLI-global flags so they don't leak into the skill call.
    // NOTE: do NOT strip `--force` here. Skills (e.g. `ppt slide.delete 3 --force`)
    // legitimately use --force as a per-action flag, and it's their semantics
    // — not the CLI-global `--force` of `yome skill install --force` — that
    // matters once we've decided this is a skill invocation.
    return !/^--?(key|base-url|baseUrl|model|provider|verbose|skill|out|no-redact|noRedact|submit|case-id|caseId|dry-run|dryRun|json|yes|grant|revoke|skip-verify|skipVerify|reason|replaced-by|replacedBy|version|allow-deprecated|allowDeprecated|org|foreground|follow|f|at|human|once|on|path|tz|cwd|allow|deny|max-ms|maxMs)(=|$)/.test(a);
  });
  const commandLine = raw.map((a) => /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
  const k = await tryKernel(commandLine);
  if (k.handled) {
    if (k.stdout) process.stdout.write(k.stdout + (k.stdout.endsWith('\n') ? '' : '\n'));
    if (k.stderr) process.stderr.write(k.stderr + (k.stderr.endsWith('\n') ? '' : '\n'));
    process.exit(k.exitCode);
  }
  // Not a known skill domain — fall through to the agent (or error).
}

// Persist config flags
if (cli.flags.key || cli.flags.baseUrl || cli.flags.provider) {
  const updates: Record<string, string> = {};
  if (cli.flags.key) updates.apiKey = cli.flags.key;
  if (cli.flags.baseUrl) updates.baseUrl = cli.flags.baseUrl;
  if (cli.flags.model) updates.model = cli.flags.model;
  if (cli.flags.provider) updates.provider = cli.flags.provider;
  saveStoredConfig(updates);
  console.log(`Config saved to ${CONFIG_PATH}`);
  if (!cli.input.length) process.exit(0);
}

let config = resolveConfig(cli.flags);

if (!config.apiKey) {
  // Fall back to the first entry in ~/.yome/settings.json customModels if present.
  const entries = loadModelEntries();
  if (entries.length > 0) {
    config = modelEntryToConfig(entries[0]);
  } else {
    console.error('No API key found.');
    console.error('Set via: yome --key sk-xxx');
    console.error('Or set YOME_API_KEY environment variable.');
    console.error('Or add a model to ~/.yome/settings.json (customModels).');
    process.exit(1);
  }
}

// Only enter interactive mode if no recognized subcommand was provided
if (
  cli.input.length === 0 ||
  !['skill', 'login', 'logout', 'whoami', 'doctor', 'thread', 'team', 'daemon', 'cron', 'mesh', '__run-task'].includes(cli.input[0])
) {
  const initialPrompt = cli.input.join(' ') || undefined;
  const appConfig = initialPrompt
    ? Object.assign({}, config, { __initialPrompt: initialPrompt })
    : config;
  render(<App config={appConfig} />);
}
