// `yome skill validate <path>` — local pre-publish lint.
//
// Mirrors the checks that `installFromLocal` does at install time, but as a
// standalone CI-friendly command. Authors run this before `yome skill publish`
// so they don't ship a broken manifest. CI calls it on every PR.
//
// Checks performed (all non-fatal listed as warnings, not errors):
//   1. yome-skill.json exists, parses, and `slug` / `domain` / `version`
//      pass the same regexes the installer uses.
//   2. system_capabilities (if present) are all in the known whitelist.
//   3. signature/<domain>.signature.json exists and parses (warn-only —
//      pure WebView skills don't need a signature).
//   4. signature.domain matches manifest.domain (hard error — common typo).
//   5. backends/sandbox/ exists if delivery.sandbox is declared (warn).
//
// Exit codes:
//   0 = all checks pass (warnings allowed)
//   1 = at least one error
//   2 = could not even read the path

import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { readManifest, validateManifest } from './manifest.js';
import { KNOWN_CAPABILITIES, type Capability } from './capabilities.js';

interface CheckReport {
  errors: string[];
  warnings: string[];
}

function pushUnknownCaps(caps: string[] | undefined, report: CheckReport): void {
  if (!caps) return;
  const unknown = caps.filter(c => !KNOWN_CAPABILITIES.includes(c as Capability));
  if (unknown.length > 0) {
    report.errors.push(
      `unknown system_capabilities: ${unknown.join(', ')} ` +
      `(allowed: ${KNOWN_CAPABILITIES.join(', ')})`,
    );
  }
}

function checkSignature(skillDir: string, manifestDomain: string, report: CheckReport): void {
  const sigDir = join(skillDir, 'signature');
  if (!existsSync(sigDir)) {
    report.warnings.push('no signature/ directory (OK for pure WebView skills)');
    return;
  }
  const sigFile = join(sigDir, `${manifestDomain}.signature.json`);
  if (!existsSync(sigFile)) {
    report.warnings.push(`signature/ exists but ${manifestDomain}.signature.json missing`);
    return;
  }
  let sig: unknown;
  try {
    sig = JSON.parse(readFileSync(sigFile, 'utf-8'));
  } catch (err) {
    report.errors.push(`signature/${manifestDomain}.signature.json: invalid JSON (${(err as Error).message})`);
    return;
  }
  const sigDomain = (sig as { domain?: unknown }).domain;
  if (sigDomain !== manifestDomain) {
    report.errors.push(
      `signature/${manifestDomain}.signature.json: domain="${String(sigDomain)}" ≠ manifest.domain="${manifestDomain}"`,
    );
  }
  const cmds = (sig as { commands?: unknown }).commands;
  if (!cmds || typeof cmds !== 'object') {
    report.errors.push(`signature/${manifestDomain}.signature.json: missing or invalid "commands" map`);
  } else if (Object.keys(cmds as object).length === 0) {
    report.warnings.push(`signature has zero commands — agent will see nothing to call`);
  }
}

function checkBackends(skillDir: string, deliveryRaw: unknown, report: CheckReport): void {
  if (!deliveryRaw || typeof deliveryRaw !== 'object') return;
  const delivery = deliveryRaw as Record<string, unknown>;
  if (delivery.sandbox && !existsSync(join(skillDir, 'backends', 'sandbox'))) {
    report.warnings.push('delivery.sandbox declared but backends/sandbox/ missing');
  }
  if (delivery.node && !existsSync(join(skillDir, 'backends', 'node'))) {
    report.warnings.push('delivery.node declared but backends/node/ missing');
  }
  if (delivery.python && !existsSync(join(skillDir, 'backends', 'python'))) {
    report.warnings.push('delivery.python declared but backends/python/ missing');
  }
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: { slug: string; domain: string; version: string };
}

export function validateSkillDir(path: string): ValidateResult {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    return { ok: false, errors: [`path does not exist: ${abs}`], warnings: [] };
  }
  if (!statSync(abs).isDirectory()) {
    return { ok: false, errors: [`not a directory: ${abs}`], warnings: [] };
  }
  const manifest = readManifest(abs);
  if (!manifest) {
    return { ok: false, errors: [`${abs}/yome-skill.json missing or unreadable`], warnings: [] };
  }
  const v = validateManifest(manifest);
  const report: CheckReport = { errors: [...v.errors], warnings: [] };
  pushUnknownCaps(manifest.system_capabilities, report);
  checkSignature(abs, manifest.domain, report);
  checkBackends(abs, manifest.delivery, report);

  return {
    ok: report.errors.length === 0,
    errors: report.errors,
    warnings: report.warnings,
    manifest: { slug: manifest.slug, domain: manifest.domain, version: manifest.version },
  };
}
