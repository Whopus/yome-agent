// Provider-agnostic cli login via the hub's web-fallback flow.
//
// Flow (mirrors npm's `--auth-type=web` style):
//   1. cli POSTs /api/cli/auth/web/start  -> { session_id, user_code, verification_url }
//   2. cli prints the URL + code, opens a browser, then polls
//      /api/cli/auth/web/poll every 5s
//   3. user signs in to yome.work (any provider) + clicks Approve
//   4. /api/cli/auth/web/complete mints a yome_cli_token, flips the session row
//   5. cli's next poll returns { status: 'approved', yome_token, user_id }
//   6. cli writes ~/.yome/auth.json
//
// Why this exists alongside the GitHub Device Flow (performLogin):
//   - performLogin only knows GitHub. Users who created their Yome account
//     with Apple / Email / WeChat have no path to login on cli without it.
//   - The web flow defers identity to the browser, so any Supabase auth
//     provider works without changing cli code.

import { writeAuthState, type YomeAuthState } from './auth.js';
import { getHubBase } from './login.js';

export interface WebLoginOptions {
  /** Hub base override (default: env YOME_HUB_BASE or https://yome.work). */
  hubBase?: string;
  /** Poll interval. Default 5s (matches GitHub Device Flow default). */
  pollIntervalMs?: number;
  /** Hard ceiling so tests don't hang forever. Default 10 min. */
  timeoutMs?: number;
  /** Test seam — sleep override. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam — open a URL in the user's browser. Defaults to a best-effort
   * `open` / `xdg-open` / `start` shell-out; falls back to printing only.
   */
  openBrowser?: (url: string) => Promise<void>;
  /** Test seam — fetch impl. */
  fetcher?: typeof fetch;
  /** Test seam — quiet console output. */
  onPrompt?: (info: StartResp) => void;
}

interface StartResp {
  ok: boolean;
  session_id?: string;
  user_code?: string;
  verification_url?: string;
  expires_in?: number;
  error?: string;
  code?: string;
}

interface PollResp {
  ok: boolean;
  status?: 'pending' | 'approved' | 'denied' | 'expired';
  yome_token?: string;
  user_id?: string;
  error?: string;
  code?: string;
}

export interface WebLoginResult {
  ok: boolean;
  state?: YomeAuthState;
  reason?: string;
  code?: 'start_failed' | 'denied' | 'expired' | 'timeout' | 'poll_failed' | 'network';
}

async function defaultOpen(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.once('error', () => { /* headless / no opener installed — user copies URL */ });
    child.unref();
  } catch { /* ignore — user can still copy the URL */ }
}

function defaultPrompt(info: StartResp): void {
  console.log('');
  console.log('  ─── Yome web login ───');
  console.log(`    Open:    ${info.verification_url}`);
  console.log(`    Code:    ${info.user_code}`);
  console.log(`    Expires: in ${Math.round((info.expires_in ?? 0) / 60)} minutes`);
  console.log('');
  console.log('Waiting for browser approval…');
}

export async function performWebLogin(opts: WebLoginOptions = {}): Promise<WebLoginResult> {
  const hubBase = (opts.hubBase ?? getHubBase()).replace(/\/+$/, '');
  const fetcher = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const open = opts.openBrowser ?? defaultOpen;

  // 1. start
  let startJson: StartResp;
  try {
    const r = await fetcher(`${hubBase}/api/cli/auth/web/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_label: `yome-cli on ${process.platform}` }),
    });
    startJson = (await r.json()) as StartResp;
    if (!r.ok || !startJson.ok || !startJson.session_id || !startJson.verification_url) {
      return { ok: false, code: 'start_failed', reason: startJson.error ?? `start failed: HTTP ${r.status}` };
    }
  } catch (e) {
    return { ok: false, code: 'network', reason: `network error on /web/start: ${(e as Error).message}` };
  }

  (opts.onPrompt ?? defaultPrompt)(startJson);
  // Fire-and-forget browser open. We don't await because some platforms
  // block until the browser process exits.
  void open(startJson.verification_url);

  // 2. poll
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    let pollJson: PollResp;
    try {
      const r = await fetcher(`${hubBase}/api/cli/auth/web/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: startJson.session_id }),
      });
      pollJson = (await r.json()) as PollResp;
      // 410 already_consumed is a logical error too — treat as poll_failed.
      if (!r.ok && r.status !== 410) {
        // 5xx during one poll is transient; keep going.
        continue;
      }
    } catch {
      // Network blip — keep polling.
      continue;
    }

    if (pollJson.status === 'pending') continue;
    if (pollJson.status === 'denied')  return { ok: false, code: 'denied', reason: 'user denied the login request' };
    if (pollJson.status === 'expired') return { ok: false, code: 'expired', reason: 'login session expired before approval' };
    if (pollJson.status === 'approved' && pollJson.yome_token && pollJson.user_id) {
      const state: YomeAuthState = {
        yome_token: pollJson.yome_token,
        yome_user_id: pollJson.user_id,
        // We don't actually know which provider the user logged in with
        // (the browser flow defers identity). Record 'email' as a generic
        // bucket — matches what the hub records for cli_token rows minted
        // via this path.
        provider: 'email',
        provider_login: undefined,
        expires_at: '',
        obtained_at: new Date().toISOString(),
      };
      writeAuthState(state);
      return { ok: true, state };
    }
    // Anything else (malformed response, etc.) — keep polling within
    // the overall timeout window.
  }
  return { ok: false, code: 'timeout', reason: 'timed out waiting for browser approval' };
}
