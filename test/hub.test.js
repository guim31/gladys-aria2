// -----------------------------------------------------------------------------
// The hub against the in-memory aria2: readings, scene events, commands,
// notifications, failures, and what reaches Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, FakeAria2, createAll, createWorld, flush, ids } from './helpers/world.js';

const BIG = '17723d4955052c56';
const SMALL = '315c4bc6d6a5ade9';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const events = (w, key) => w.fake.sceneEvents.filter((event) => event.key === key);
const state = (w, key) => w.fake.lastState(ids(w.gladys).feature(key));

test('one device, read at start, no scene event for what was already there', async (t) => {
  const w = await world(t);
  assert.equal(w.fake.discoveredDevices.length, 1);
  const [device] = w.fake.discoveredDevices;
  assert.equal(device.name, 'NAS');
  assert.equal(device.external_id, ids(w.gladys).device);
  assert.equal(device.should_poll, false);
  assert.deepEqual(device.params, [
    { name: 'ARIA2_RPC_URL', value: 'http://192.0.2.10:6800/jsonrpc' },
  ]);
  // The busy fixture: two active, one complete, one dead link.
  assert.equal(state(w, 'downloads_active'), 2);
  assert.equal(state(w, 'downloads_waiting'), 0);
  assert.equal(state(w, 'downloads_completed'), 1);
  assert.equal(state(w, 'downloads_error'), 1);
  assert.equal(state(w, 'download_speed'), 1398); // 1317857 + 80199 bytes/s
  assert.equal(state(w, 'paused'), 0);
  assert.equal(state(w, 'slow_down'), 0);
  assert.equal(state(w, 'download_limit'), 0);
  assert.equal(state(w, 'connected'), 1);
  const text = w.fake.states.findLast(
    (s) => s.device_feature_external_id === ids(w.gladys).feature('current_downloads'),
  ).text;
  assert.equal(text, 'small.1.bin 8% · big.iso 0%');
  assert.deepEqual(w.fake.sceneEvents, []);
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.deepEqual(w.fake.transports.at(-1), {
    device_external_id: ids(w.gladys).device,
    transport: 'local',
  });
});

test('download completed, download failed, then nothing left to download', async (t) => {
  const w = await world(t, { sockets: false });
  w.aria2.complete(BIG);
  await w.hub.pollAll();
  assert.deepEqual(
    events(w, 'download_completed').map((e) => e.data),
    [{ name: 'big.iso', size_gb: 0.21, dir: '/downloads/iso' }],
  );
  assert.deepEqual(events(w, 'queue_empty'), []);

  w.aria2.fail(SMALL, '8', 'Invalid range header.');
  await w.hub.pollAll();
  assert.deepEqual(
    events(w, 'download_error').map((e) => e.data),
    [{ name: 'small.1.bin', error_code: 8, error: 'Invalid range header.' }],
  );
  assert.deepEqual(
    events(w, 'queue_empty').map((e) => e.data),
    [{ completed: 2, errors: 2 }],
  );

  // Nothing new: nothing fired again.
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 3);
});

test('a link added and finished (or dead) between two readings is announced', async (t) => {
  const w = await world(t, { sockets: false });
  w.aria2.add({
    status: 'complete',
    totalLength: '1000',
    completedLength: '1000',
    files: [{ path: '/downloads/report.pdf', uris: [] }],
  });
  w.aria2.add({
    status: 'error',
    errorCode: '3',
    errorMessage: 'Resource not found',
    files: [{ path: '', uris: [{ uri: 'https://files.example.com/gone.zip?token=x' }] }],
  });
  await w.hub.pollAll();
  assert.deepEqual(
    events(w, 'download_completed').map((e) => e.data.name),
    ['report.pdf'],
  );
  assert.deepEqual(
    events(w, 'download_error').map((e) => e.data),
    [{ name: 'gone.zip', error_code: 3, error: 'Resource not found' }],
  );
});

test('a torrent is completed as soon as it seeds, once; its metadata never counts', async (t) => {
  const aria2 = new FakeAria2({ downloads: [] });
  aria2.add({
    gid: 'meta',
    status: 'complete',
    totalLength: '0',
    completedLength: '0',
    bittorrent: {},
    followedBy: ['iso'],
    files: [{ path: '[METADATA]debian', uris: [] }],
  });
  aria2.add({
    gid: 'iso',
    status: 'active',
    totalLength: '100',
    completedLength: '50',
    downloadSpeed: '10',
    bittorrent: { info: { name: 'debian-13.iso' } },
  });
  const w = await world(t, { aria2, sockets: false });
  assert.equal(state(w, 'downloads_completed'), 0, 'the metadata is not a completed download');
  assert.equal(state(w, 'downloads_active'), 1);

  aria2.set('iso', { completedLength: '100', uploadSpeed: '5' });
  await w.hub.pollAll();
  assert.deepEqual(
    events(w, 'download_completed').map((e) => e.data.name),
    ['debian-13.iso'],
  );
  assert.equal(state(w, 'downloads_active'), 0, 'sharing is not downloading');
  assert.equal(state(w, 'downloads_completed'), 1);
  assert.equal(events(w, 'queue_empty').length, 1);

  // The seed ratio is reached: aria2 stops it, complete. No second event.
  aria2.set('iso', { status: 'complete' });
  await w.hub.pollAll();
  assert.equal(events(w, 'download_completed').length, 1);
});

test('a notification of aria2 makes the hub read at once', async (t) => {
  const w = await world(t);
  await flush();
  assert.equal(w.hub.record.notifications.open, true);
  const reads = w.aria2.calls.length;
  w.aria2.complete(BIG);
  await flush();
  await flush();
  assert.equal(w.aria2.calls.length, reads + 1);
  assert.equal(events(w, 'download_completed').length, 1);
  // Not a notification method: ignored.
  w.hub.record.notifications.socket.emit('message', { data: '{"id":"1","result":"OK"}' });
  w.hub.record.notifications.socket.emit('message', { data: 'not json' });
  await flush();
  assert.equal(w.aria2.calls.length, reads + 1);
});

test('the WebSocket reconnects with a growing delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aria2 = new FakeAria2();
  aria2.down = true;
  const w = await world(t, { aria2, timers: true });
  await flush();
  const notifications = w.hub.record.notifications;
  assert.equal(notifications.open, false);
  assert.equal(notifications.retryMs, 10_000, 'next delay doubled');
  aria2.down = false;
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(notifications.open, true);
  assert.equal(notifications.retryMs, 5_000, 'delay reset once open');
  // aria2 restarts: the socket closes, and comes back.
  [...aria2.sockets][0].close();
  assert.equal(notifications.open, false);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(notifications.open, true);
});

test('the pause switch pauses and resumes everything', async (t) => {
  const w = await world(t);
  await createAll(w);
  const device = w.fake.devices[0];
  const feature = device.features.find((f) => f.external_id.endsWith(':paused'));
  assert.deepEqual(await w.fake.setValue(device, feature, 1), { success: true });
  assert.ok(w.aria2.calls.includes('aria2.pauseAll'));
  assert.equal(state(w, 'paused'), 1);
  assert.equal(state(w, 'downloads_waiting'), 2);
  assert.equal(state(w, 'downloads_active'), 0);
  assert.deepEqual(events(w, 'queue_empty'), [], 'paused downloads are still to do');

  assert.deepEqual(await w.fake.setValue(device, feature, 0), { success: true });
  assert.ok(w.aria2.calls.includes('aria2.unpauseAll'));
  assert.equal(state(w, 'paused'), 0);
});

test('the slow-down switch sets the limit of the configuration, then none', async (t) => {
  const w = await world(t, { config: { ...CONFIG, slow_limit: 250 } });
  await createAll(w);
  const device = w.fake.devices[0];
  const feature = device.features.find((f) => f.external_id.endsWith(':slow_down'));
  await w.fake.setValue(device, feature, 1);
  assert.equal(w.aria2.limit, '250000');
  assert.equal(state(w, 'slow_down'), 1);
  assert.equal(state(w, 'download_limit'), 250);
  await w.fake.setValue(device, feature, 0);
  assert.equal(w.aria2.limit, '0');
  assert.equal(state(w, 'slow_down'), 0);
  // Another feature cannot be controlled.
  const other = device.features.find((f) => f.external_id.endsWith(':downloads_active'));
  const ack = await w.fake.setValue(device, other, 1);
  assert.equal(ack.success, false);
});

test('scene actions: add a link, set a limit, with their checks', async (t) => {
  const w = await world(t, { config: { ...CONFIG, language: 'fr' } });
  const ok = await w.fake.sceneAction('add_uri', {
    uri: ' https://files.example.com/a.iso ',
    dir: '/downloads/films',
  });
  assert.equal(ok.success, true, ok.error);
  const added = w.aria2.get(ok.data.outputs.gid);
  assert.equal(added.dir, '/downloads/films');
  assert.equal(added.files[0].uris[0].uri, 'https://files.example.com/a.iso');
  assert.equal(
    (await w.fake.sceneAction('add_uri', { uri: 'magnet:?xt=urn:btih:abc' })).success,
    true,
  );

  for (const uri of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'notaurl', undefined]) {
    const ack = await w.fake.sceneAction('add_uri', { uri });
    assert.equal(ack.success, false, String(uri));
    assert.match(ack.error, /lien/);
  }
  for (const dir of ['downloads', '/downloads/../etc', '..']) {
    const ack = await w.fake.sceneAction('add_uri', { uri: 'https://x.example/a', dir });
    assert.equal(ack.success, false, dir);
    assert.match(ack.error, /chemin absolu/);
  }

  assert.equal((await w.fake.sceneAction('set_download_limit', { limit: 500 })).success, true);
  assert.equal(w.aria2.limit, '500000');
  assert.equal((await w.fake.sceneAction('set_download_limit', { limit: '0' })).success, true);
  assert.equal(w.aria2.limit, '0');
  for (const limit of [-1, 1.5, 'abc', '', undefined]) {
    const ack = await w.fake.sceneAction('set_download_limit', { limit });
    assert.equal(ack.success, false, String(limit));
  }
  assert.equal(w.aria2.limit, '0');
});

test('a command refused by aria2 says why, in the configured language', async (t) => {
  const w = await world(t, { config: { ...CONFIG, language: 'de' } });
  w.aria2.run = () => ({ error: { code: 1, message: 'No URI to download.' } });
  const ack = await w.fake.sceneAction('add_uri', { uri: 'https://x.example/a' });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'NAS: Befehl von aria2 abgelehnt, sieh in den Protokollen nach');
});

test('a wrong secret: connection status, connected 0, no retry storm', async (t) => {
  const w = await world(t, { aria2: new FakeAria2({ secret: 'other' }) });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.equal(
    w.fake.connectionStatus.message.fr,
    'NAS : secret refusé : vérifiez le secret RPC (--rpc-secret)',
  );
  assert.equal(state(w, 'connected'), 0);
  assert.equal(w.hub.record.retryTimer, null);
  const report = await w.fake.action('test_connection', {});
  assert.match(report.data.message.en, /secret refused/);
});

test('aria2 down, then back: unreachable transport, then local, one log each', async (t) => {
  const aria2 = new FakeAria2();
  const w = await world(t, { aria2 });
  aria2.down = true;
  await w.hub.pollAll();
  assert.equal(state(w, 'connected'), 0);
  assert.equal(w.fake.transports.at(-1).transport, 'unreachable');
  assert.match(w.fake.connectionStatus.message.en, /does not answer/);
  aria2.down = false;
  w.clock.advance(5 * 60_000);
  await w.hub.pollAll();
  assert.equal(state(w, 'connected'), 1);
  assert.equal(w.fake.transports.at(-1).transport, 'local');
  assert.equal(w.fake.connectionStatus.connected, true);
});

test('not the aria2 RPC at this address', async (t) => {
  const aria2 = new FakeAria2();
  aria2.html = true;
  const w = await world(t, { aria2 });
  assert.match(w.fake.connectionStatus.message.en, /no aria2 RPC at this address/);
});

test('no address, or one not understood', async (t) => {
  const empty = await world(t, { config: { language: 'en' } });
  assert.deepEqual(empty.fake.discoveredDevices, []);
  assert.match(empty.fake.connectionStatus.message.en, /Enter the RPC address/);
  const ack = await empty.fake.sceneAction('pause_all', {});
  assert.equal(ack.error, 'No aria2 server is configured.');

  const bad = await world(t, { config: { rpc_url: 'ftp://192.0.2.10', language: 'en' } });
  assert.match(bad.fake.connectionStatus.message.en, /Address not understood/);
});

test('the states go again when the device is added, and the widget refreshes', async (t) => {
  const w = await world(t);
  const before = w.fake.states.length;
  await createAll(w);
  assert.equal(w.fake.states.length - before, 11, 'every feature published again');
  assert.ok(w.fake.widgetRefreshes.includes('downloads'));
});

test('a new configuration: new address, same device; language change rewrites the text', async (t) => {
  const w = await world(t);
  await w.fake.configUpdated({ ...CONFIG, rpc_url: 'https://192.0.2.10/aria2/jsonrpc' });
  assert.equal(w.fake.discoveredDevices[0].external_id, ids(w.gladys).device);
  assert.equal(w.hub.record.server.url, 'https://192.0.2.10/aria2/jsonrpc');
  await w.fake.configUpdated({
    ...CONFIG,
    rpc_url: 'https://192.0.2.10/aria2/jsonrpc',
    language: 'fr',
  });
  const text = w.fake.states.findLast(
    (s) => s.device_feature_external_id === ids(w.gladys).feature('current_downloads'),
  ).text;
  assert.equal(text, 'small.1.bin 8\u202f% · big.iso 0\u202f%');
});

test('the integration reads aria2 on its own timer, without onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t, {
    timers: true,
    sockets: false,
    config: { ...CONFIG, poll_interval: '10' },
  });
  const reads = w.aria2.calls.length;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(w.aria2.calls.length, reads + 1);
});

test('no request ever removes a download or purges the results', async (t) => {
  const w = await world(t);
  await w.fake.sceneAction('pause_all', {});
  await w.fake.sceneAction('resume_all', {});
  await w.fake.sceneAction('add_uri', { uri: 'https://x.example/a' });
  await w.fake.widgetAction('downloads', 'slow_down', { enabled: true }, { settings: {} });
  const methods = w.aria2.calls.flat();
  assert.ok(!methods.some((m) => /remove|purge|shutdown|forceShutdown/i.test(m)), methods);
});

test('the secret never leaves in clear outside the RPC body', async (t) => {
  const w = await world(t, {
    aria2: new FakeAria2({ secret: 'hunter2' }),
    config: { ...CONFIG, rpc_secret: 'hunter2' },
  });
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.ok(!JSON.stringify(w.fake.discoveredDevices).includes('hunter2'));
  assert.ok(!JSON.stringify(w.fake.connectionStatuses).includes('hunter2'));
  assert.ok(!w.hub.record.server.wsUrl.includes('hunter2'));
});
