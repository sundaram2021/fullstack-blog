import dotenv from 'dotenv';

// Shared secrets live in the repo-root .env (same file the Python app uses).
// Works from src/ (tsx) and dist/ (built): ../../.env == repo root.
dotenv.config({ path: new URL('../../.env', import.meta.url) });

function clean(v: string | undefined): string {
  let s = (v ?? '').trim().replace(/^["']|["']$/g, '').trim();
  if (s.toLowerCase().startsWith('bearer ')) s = s.slice(7).trim();
  return s;
}

function first(...names: string[]): string {
  for (const n of names) {
    const v = clean(process.env[n]);
    if (v) return v;
  }
  return '';
}

export const MODEL_NAME =
  clean(process.env.MODEL_NAME) || 'moonshotai/Kimi-K3';

export function resolveBaseUrl(): string {
  const raw = first('MODAL_URL_ENDPOINT', 'MODAL_ENDPOINT_URL', 'MODAL_BASE_URL').replace(/\/+$/, '');
  if (!raw) return '';
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

export function resolveProxyKey(): { id: string; secret: string; apiKey: string } {
  const id = first('MODAL_PROXY_TOKEN_ID', 'MODAL_TOKEN_PROXY_ID');
  const secret = first('MODAL_PROXY_TOKEN_SECRET', 'MODAL_TOKEN_PROXY_SECRET');
  if (id && secret) return { id, secret, apiKey: `${id}.${secret}` };
  return { id, secret, apiKey: first('MODAL_PROXY_API_KEY', 'OPENAI_API_KEY') };
}

export function assertConfigured(): { baseURL: string; apiKey: string } {
  const baseURL = resolveBaseUrl();
  const { id, secret, apiKey } = resolveProxyKey();
  const missing: string[] = [];
  if (!baseURL) missing.push('MODAL_URL_ENDPOINT');
  if (!id) missing.push('MODAL_PROXY_TOKEN_ID');
  if (!secret) missing.push('MODAL_PROXY_TOKEN_SECRET');
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Inference endpoint not configured. Missing: ${missing.join(', ')}. Add them to the repo-root .env and restart.`),
      { statusCode: 502 },
    );
  }
  if (secret.startsWith('as-')) {
    throw Object.assign(
      new Error(
        `Wrong proxy secret (starts with 'as-' — that's the Modal API token secret). ` +
        `MODAL_PROXY_TOKEN_SECRET must be the 'ws-...' proxy secret, so the key becomes wk-....ws-....`,
      ),
      { statusCode: 502 },
    );
  }
  return { baseURL, apiKey };
}
