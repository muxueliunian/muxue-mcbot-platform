import fs from 'node:fs';
import { BodyError } from './body.js';

/** The server's rejection text, kept only for the local hosting log (never the agent): control characters out, at most 200 characters. */
export function serverDetail(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  return clean || undefined;
}

/** What the hosting log says when taking the body failed: a fixed hint for known causes, otherwise the code and the server's words. */
export function claimFailureText(error: Error): string {
  const code = error instanceof BodyError ? error.code : '';
  const detail = error instanceof BodyError ? error.detail : undefined;
  // ServerController.ensureBody: an existing or saved body that is not in survival (e.g. a LAN world opened in creative).
  if (code === 'FORBIDDEN' && detail && /not in survival mode/i.test(detail))
    return 'Bot 不是生存模式，无法接管。目前只支持生存模式；开局域网时游戏模式请选「生存」。';
  return `接管失败（${code || error.name}）：${detail ?? error.message}`;
}

/**
 * Append the failure to the WebUI's activity file (the driver's activity-<name>.jsonl). The driver restarts the runtime
 * after a failure, so the same text within ten minutes is written once; a log that cannot be read or written is skipped.
 */
export function logClaimFailure(file: string, error: Error, now = Date.now()): void {
  const text = claimFailureText(error);
  try {
    let tail = '';
    try { const all = fs.readFileSync(file, 'utf8'); tail = all.slice(-16384); } catch { /* no log yet */ }
    for (const line of tail.split('\n').reverse()) {
      if (!line.trim()) continue;
      let entry: { t?: number; kind?: string; text?: string };
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry.t === 'number' && now - entry.t > 600_000) break;
      if (entry.kind === 'error' && entry.text === text) return;
    }
    fs.appendFileSync(file, JSON.stringify({ t: now, kind: 'error', source: 'runtime', text }) + '\n');
  } catch { /* the hosting log is a convenience */ }
}
