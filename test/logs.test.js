// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal reading writes nothing, a failure that repeats is logged
// once, and its end once. Never the RPC secret, nor a link that may carry a
// token. (Adapted from guim31/gladys-torrent.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, FakeAria2, createWorld, flush } from './helpers/world.js';

/** Capture the lines of the SDK logger at LOG_LEVEL=info. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('a normal reading cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  await flush();
  assert.equal(logs.texts().filter((text) => text.includes('connected to aria2 1.37.0')).length, 1);
  logs.clear();

  for (let i = 1; i <= 5; i += 1) {
    w.aria2.set('17723d4955052c56', { completedLength: String(i * 1e7), downloadSpeed: '1000' });
    await w.hub.pollAll();
  }
  // Completed and failed downloads are scene events, not log lines; the
  // notifications of aria2 are read silently too.
  w.aria2.complete('17723d4955052c56');
  w.aria2.fail('315c4bc6d6a5ade9');
  await flush();
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 3);
  assert.deepEqual(logs.texts(), []);
});

test('an outage: one warning, one line when aria2 is back', async (t) => {
  const logs = captureLogs(t);
  const aria2 = new FakeAria2();
  const w = await world(t, { aria2, sockets: false });
  logs.clear();
  aria2.down = true;
  for (let i = 0; i < 4; i += 1) {
    await w.hub.pollAll();
  }
  assert.deepEqual(logs.texts().map(strip), ['aria2 (NAS): ECONNREFUSED']);
  logs.clear();
  aria2.down = false;
  w.clock.advance(3 * 60_000);
  await w.hub.pollAll();
  assert.deepEqual(logs.texts().map(strip), ['aria2 (NAS) answers again after 3 min']);
});

test('one line per user command, without the secret nor the link', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, {
    aria2: new FakeAria2({ secret: 'hunter2' }),
    config: { ...CONFIG, rpc_secret: 'hunter2' },
  });
  logs.clear();
  await w.fake.sceneAction('add_uri', { uri: 'https://files.example.com/a.iso?token=abc123' });
  await w.fake.sceneAction('add_uri', {
    uri: 'magnet:?xt=urn:btih:abc&tr=https://t.example/abc123',
  });
  await w.fake.sceneAction('set_download_limit', { limit: 100 });
  const texts = logs.texts().map(strip);
  assert.deepEqual(texts, [
    'aria2 (NAS): a link to files.example.com added',
    'aria2 (NAS): a magnet link added',
    'aria2 (NAS): download limit set to 100 kB/s',
  ]);
  assert.ok(!logs.texts().some((text) => /hunter2|abc123/.test(text)));
});

/** The message of a log line, without its timestamp, level and logger name. */
function strip(text) {
  return text.replace(/^.*?\[aria2-hub\]\s*/, '').replace(/^\S+\s+(INFO|WARN|ERROR)\s+/, '');
}
