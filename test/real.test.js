// -----------------------------------------------------------------------------
// Optional test against a real aria2 (`npm run test:real`), skipped unless its
// address is given in the environment — so skipped in CI:
//
//   ARIA2_URL=127.0.0.1:6800 ARIA2_SECRET=… [ARIA2_FILES=http://host:8000]
//
// Use a test instance: the test pauses and resumes everything and sets then
// removes the global download limit. With ARIA2_FILES (a plain HTTP file
// server holding small.bin), it also adds small.bin and a dead link, and
// waits for their scene events. It never removes anything.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { registerHandlers } from '../src/app.js';

process.env.LOG_LEVEL ??= 'silent';

const { ARIA2_URL, ARIA2_SECRET = '', ARIA2_FILES } = process.env;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) {
      return;
    }
    await settle(200);
  }
  assert.fail('timed out');
}

test('real aria2', { skip: !ARIA2_URL && 'no ARIA2_URL' }, async () => {
  const gladys = createFakeGladys({
    config: { rpc_url: ARIA2_URL, rpc_secret: ARIA2_SECRET, language: 'en', slow_limit: 300 },
  });
  const app = registerHandlers(gladys);
  try {
    await gladys.connect();
    await app.ready;
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const report = await gladys.fake.action('test_connection', {});
    assert.match(report.data.message.en, /OK, aria2 1\./);
    await until(() => app.hub.record.notifications.open);

    const widget = await gladys.fake.widgetGet('downloads', { settings: {}, language: 'en' });
    assert.deepEqual(validateWidgetContent(widget.data.content), []);

    assert.equal(
      (await gladys.fake.sceneAction('set_download_limit', { limit: 300 })).success,
      true,
    );
    assert.equal(app.hub.record.reading.downloadLimit, 300_000);
    assert.equal((await gladys.fake.sceneAction('set_download_limit', { limit: 0 })).success, true);
    assert.equal(app.hub.record.reading.downloadLimit, 0);
    assert.equal((await gladys.fake.sceneAction('pause_all', {})).success, true);
    assert.equal((await gladys.fake.sceneAction('resume_all', {})).success, true);

    const wrong = await gladys.fake.sceneAction('add_uri', { uri: 'ftp://' });
    assert.equal(wrong.success, false);

    if (ARIA2_FILES) {
      const added = await gladys.fake.sceneAction('add_uri', {
        uri: `${ARIA2_FILES}/small.bin?real=${Date.now()}`,
        dir: '/downloads/real-test',
      });
      assert.equal(added.success, true, added.error);
      await gladys.fake.sceneAction('add_uri', { uri: `${ARIA2_FILES}/missing-${Date.now()}.zip` });
      // The WebSocket brings the events well before the 30 s timer.
      await until(() =>
        ['download_completed', 'download_error', 'queue_empty'].every((key) =>
          gladys.fake.sceneEvents.some((event) => event.key === key),
        ),
      );
      const done = gladys.fake.sceneEvents.find((e) => e.key === 'download_completed');
      assert.equal(done.data.dir, '/downloads/real-test');
      const failed = gladys.fake.sceneEvents.find((e) => e.key === 'download_error');
      assert.equal(failed.data.error_code, 3);
    }
  } finally {
    await app.stop();
  }
});
