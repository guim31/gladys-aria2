// -----------------------------------------------------------------------------
// The JSON-RPC client and the reading, on the answers recorded from aria2
// 1.37.0 (test/fixtures/aria2/).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Aria2Client, downloadName, parseDownload } from '../src/aria2.js';
import { Aria2Rpc, ERROR_KINDS } from '../src/rpc.js';
import { countDownloads, diffDownloads } from '../src/model.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/aria2/${name}.json`, import.meta.url), 'utf8'));

const replay = (answer, status = 200) => {
  const sent = [];
  const request = async (url, options) => {
    sent.push({ url, ...options, body: JSON.parse(options.body) });
    return { status, headers: {}, body: JSON.stringify(answer) };
  };
  return { request, sent };
};

const SERVER = { url: 'http://192.0.2.10:6800/jsonrpc', secret: 'testsecret' };

test('a reading is one multicall, with the secret first in every call', async () => {
  const { request, sent } = replay(await fixture('busy'));
  const reading = await new Aria2Client(SERVER, { request }).read();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].body.method, 'system.multicall');
  const calls = sent[0].body.params[0];
  assert.deepEqual(
    calls.map((c) => c.methodName),
    [
      'aria2.getVersion',
      'aria2.getGlobalStat',
      'aria2.getGlobalOption',
      'aria2.tellActive',
      'aria2.tellWaiting',
      'aria2.tellStopped',
    ],
  );
  assert.ok(calls.every((c) => c.params[0] === 'token:testsecret'));
  assert.equal(reading.version, '1.37.0');
  assert.equal(reading.downloadSpeed, 1459114);
  assert.equal(reading.downloadLimit, 2000000);
  assert.deepEqual(
    reading.downloads.map((d) => [d.name, d.status, d.dir]),
    [
      ['big.iso', 'active', '/downloads/iso'],
      ['small.1.bin', 'active', '/downloads'],
      ['small.bin', 'complete', '/downloads'],
      ['missing.zip', 'error', '/downloads'],
    ],
  );
  assert.deepEqual(reading.downloads[3], {
    gid: '14a4f7a08289886e',
    name: 'missing.zip',
    status: 'error',
    total: 0,
    completed: 0,
    downloadSpeed: 0,
    dir: '/downloads',
    errorCode: 3,
    errorMessage: 'Resource not found',
    seeding: false,
    metadata: false,
  });
});

test('the recorded sessions: paused, then over', async () => {
  const read = async (name) =>
    new Aria2Client(SERVER, { request: replay(await fixture(name)).request }).read();
  const paused = await read('paused');
  assert.deepEqual(countDownloads(paused.downloads), {
    active: 0,
    waiting: 2,
    paused: 2,
    completed: 1,
    errors: 1,
  });
  const done = await read('done');
  assert.deepEqual(countDownloads(done.downloads), {
    active: 0,
    waiting: 0,
    paused: 0,
    completed: 1,
    errors: 3,
  });
  // From the busy reading to the end: two failures (the file server refused
  // the resumed ranges), and nothing left.
  const memory = { known: new Map(), pending: null };
  diffDownloads(memory, (await read('busy')).downloads, true);
  const events = diffDownloads(memory, done.downloads, false);
  assert.deepEqual(
    events.failed.map((d) => d.name),
    ['small.1.bin', 'big.iso'],
  );
  assert.equal(events.queueEmpty, true);
});

test('errors: wrong secret (alone or in a multicall), refused command, not aria2, down', async () => {
  const errors = await fixture('errors');
  const rpc = (answer, status) =>
    new Aria2Rpc({ ...SERVER, request: replay(answer, status).request });
  await assert.rejects(rpc(errors.unauthorized.body, 400).call('aria2.getVersion'), {
    kind: ERROR_KINDS.AUTH,
  });
  await assert.rejects(rpc(errors.multicallWrongToken.body).multicall([['aria2.getVersion']]), {
    kind: ERROR_KINDS.AUTH,
  });
  await assert.rejects(rpc(errors.badUri.body, 400).call('aria2.addUri', ['x']), {
    kind: ERROR_KINDS.REJECTED,
    message: 'aria2.addUri: No URI to download.',
  });
  const html = new Aria2Rpc({
    ...SERVER,
    request: async () => ({ status: 404, headers: {}, body: '<html></html>' }),
  });
  await assert.rejects(html.call('aria2.getVersion'), { kind: ERROR_KINDS.NOT_FOUND });
  const fail = (code) =>
    new Aria2Rpc({
      ...SERVER,
      request: async () => {
        throw Object.assign(new Error('x'), { code });
      },
    });
  await assert.rejects(fail('ECONNREFUSED').call('aria2.getVersion'), {
    kind: ERROR_KINDS.UNREACHABLE,
  });
  await assert.rejects(fail('DEPTH_ZERO_SELF_SIGNED_CERT').call('aria2.getVersion'), {
    kind: ERROR_KINDS.TLS,
  });
  assert.equal(await rpc(errors.ok.body).call('aria2.pauseAll'), 'OK');
});

test('without a secret, no token is sent', async () => {
  const { request, sent } = replay({ jsonrpc: '2.0', id: '1', result: 'OK' });
  await new Aria2Rpc({ url: SERVER.url, secret: '', request }).call('aria2.pauseAll');
  assert.deepEqual(sent[0].body.params, []);
});

test('download names: torrent, file, URI, magnet, gid', () => {
  assert.equal(downloadName({ gid: 'g', bittorrent: { info: { name: 'Debian' } } }), 'Debian');
  assert.equal(downloadName({ gid: 'g', files: [{ path: '/d/My%20file.iso' }] }), 'My%20file.iso');
  assert.equal(
    downloadName({
      gid: 'g',
      files: [{ path: '', uris: [{ uri: 'https://x.example/My%20file.iso?t=1' }] }],
    }),
    'My file.iso',
  );
  assert.equal(
    downloadName({
      gid: 'g',
      files: [{ path: '', uris: [{ uri: 'magnet:?xt=urn:btih:abc&dn=Big+Buck' }] }],
    }),
    'Big Buck',
  );
  assert.equal(downloadName({ gid: 'g', files: [] }), 'g');
  const seeding = parseDownload({
    gid: 'g',
    status: 'active',
    totalLength: '10',
    completedLength: '10',
    bittorrent: {},
  });
  assert.equal(seeding.seeding, true);
});
