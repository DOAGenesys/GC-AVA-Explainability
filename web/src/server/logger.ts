import 'server-only';

/**
 * Structured JSON logging with token redaction. Everything here lands in Vercel's log drain, so
 * anything that could carry a bearer token, a signed download URI or customer utterances has to
 * be scrubbed on the way out.
 */

const SENSITIVE_KEYS =
  /^(authorization|access_?token|refresh_?token|client_?secret|code|code_verifier|password|downloaduri)$/i;
const TOKEN_LIKE = /\b(?:eyJ[\w-]{10,}|[A-Za-z0-9_-]{40,})\b/g;

function scrubString(value: string): string {
  return value.replace(TOKEN_LIKE, '[redacted]');
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Strip query strings, which is where Genesys puts signature material. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`;
  } catch {
    return '[unparseable-url]';
  }
}

function emit(level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown): void {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(data ? { data: scrub(data) } : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, data?: unknown) => emit('debug', event, data),
  info: (event: string, data?: unknown) => emit('info', event, data),
  warn: (event: string, data?: unknown) => emit('warn', event, data),
  error: (event: string, data?: unknown) => emit('error', event, data),
};
