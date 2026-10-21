import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseRpcUrl } from '../src/config.js';

test('the RPC address: host, port, path and scheme', () => {
  const cases = {
    '192.0.2.10': ['http://192.0.2.10:6800/jsonrpc', 'ws://192.0.2.10:6800/jsonrpc'],
    ' nas.local:6801 ': ['http://nas.local:6801/jsonrpc', 'ws://nas.local:6801/jsonrpc'],
    'http://192.0.2.10:6800/jsonrpc': [
      'http://192.0.2.10:6800/jsonrpc',
      'ws://192.0.2.10:6800/jsonrpc',
    ],
    'ws://192.0.2.10:6800/jsonrpc/': [
      'http://192.0.2.10:6800/jsonrpc',
      'ws://192.0.2.10:6800/jsonrpc',
    ],
    'wss://dl.example.com/aria2/jsonrpc': [
      'https://dl.example.com/aria2/jsonrpc',
      'wss://dl.example.com/aria2/jsonrpc',
    ],
    'https://dl.example.com': ['https://dl.example.com/jsonrpc', 'wss://dl.example.com/jsonrpc'],
    '[2001:db8::1]:6800': ['http://[2001:db8::1]:6800/jsonrpc', 'ws://[2001:db8::1]:6800/jsonrpc'],
  };
  for (const [typed, [http, ws]] of Object.entries(cases)) {
    assert.deepEqual(parseRpcUrl(typed), { http, ws }, typed);
  }
  for (const bad of ['', '   ', 'ftp://192.0.2.10', 'http://user:pass@192.0.2.10', 'http://', 42]) {
    assert.equal(parseRpcUrl(bad), null, String(bad));
  }
});

test('normalization: defaults, bounds, a secret kept as typed', () => {
  const config = normalizeConfig({
    rpc_url: '192.0.2.10',
    rpc_secret: ' s3cret ',
    name: '  ',
    poll_interval: 60,
    slow_limit: '250',
    language: 'de',
    allow_self_signed: 'true',
  });
  assert.deepEqual(config, {
    server: {
      url: 'http://192.0.2.10:6800/jsonrpc',
      wsUrl: 'ws://192.0.2.10:6800/jsonrpc',
      secret: ' s3cret ',
      name: null,
    },
    invalidUrl: false,
    allowSelfSigned: true,
    pollIntervalMs: 60_000,
    slowLimitKbps: 250,
    language: 'de',
  });
  const defaults = normalizeConfig({});
  assert.equal(defaults.server, null);
  assert.equal(defaults.invalidUrl, false);
  assert.equal(defaults.pollIntervalMs, 30_000);
  assert.equal(defaults.slowLimitKbps, DEFAULT_CONFIG.slow_limit);
  assert.equal(defaults.language, 'fr');
  assert.equal(normalizeConfig({ rpc_url: 'ftp://x' }).invalidUrl, true);
  assert.equal(normalizeConfig({ slow_limit: 0 }).slowLimitKbps, 1000);
  assert.equal(normalizeConfig({ slow_limit: 1e12 }).slowLimitKbps, 10_000_000);
  assert.equal(normalizeConfig({ poll_interval: '5', language: 'it' }).pollIntervalMs, 30_000);
  assert.equal(normalizeConfig(null).server, null);
});
