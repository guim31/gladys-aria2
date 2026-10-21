// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One aria2 server: its RPC address, its secret (--rpc-secret), a name, the
// refresh interval, the "slow down" limit and the language of the texts.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// The port and path aria2 listens on out of the box (--rpc-listen-port).
export const DEFAULT_PORT = 6800;
export const RPC_PATH = '/jsonrpc';

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['10', '15', '30', '60', '120'];

export const DEFAULT_CONFIG = {
  rpc_url: '',
  rpc_secret: '',
  name: '',
  allow_self_signed: false,
  poll_interval: '30',
  slow_limit: 1000,
  language: 'fr',
};

const MAX_NAME_LENGTH = 40;
// Bounds of the "slow down" limit, in kB/s (1 kB/s to 10 GB/s).
export const MAX_LIMIT_KBPS = 10_000_000;

/**
 * Parse the address typed by the user into the JSON-RPC URL: a bare host or
 * IP (`192.0.2.10`, `nas.local:6800`), or a full URL, in HTTP(S) or WebSocket
 * (`ws://192.0.2.10:6800/jsonrpc`, as AriaNg shows it). HTTP and port 6800 by
 * default, `/jsonrpc` when no path was typed (a reverse proxy may serve it
 * elsewhere).
 * @param {unknown} raw
 * @returns {{ http: string, ws: string }|null} null when unusable
 */
export function parseRpcUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  const secure = { 'http:': false, 'ws:': false, 'https:': true, 'wss:': true }[url.protocol];
  if (secure === undefined || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs and the device params.
  if (url.username || url.password) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(DEFAULT_PORT);
  }
  const path = url.pathname.replace(/\/+$/, '') || RPC_PATH;
  const host = url.host;
  return {
    http: `${secure ? 'https' : 'http'}://${host}${path}`,
    ws: `${secure ? 'wss' : 'ws'}://${host}${path}`,
  };
}

/** Host part shown to the user (no scheme, no path). */
export const hostOf = (url) => new URL(url).host;

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const flag = (key) => source[key] === true || source[key] === 'true';

  const typed = text('rpc_url');
  const urls = typed ? parseRpcUrl(typed) : null;
  const limit = Math.round(Number(source.slow_limit));

  return {
    server: urls
      ? {
          url: urls.http,
          wsUrl: urls.ws,
          // Kept as typed: aria2 compares it byte for byte.
          secret: typeof source.rpc_secret === 'string' ? source.rpc_secret : '',
          name: text('name').slice(0, MAX_NAME_LENGTH) || null,
        }
      : null,
    invalidUrl: Boolean(typed) && !urls,
    allowSelfSigned: flag('allow_self_signed'),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    slowLimitKbps:
      Number.isFinite(limit) && limit >= 1
        ? Math.min(limit, MAX_LIMIT_KBPS)
        : DEFAULT_CONFIG.slow_limit,
    language: pick('language', LANGUAGES),
  };
}
