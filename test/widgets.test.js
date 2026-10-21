// -----------------------------------------------------------------------------
// The `downloads` widget: content within the core budget and vocabulary, in
// every state, and its three buttons.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { CONFIG, FakeAria2, createWorld } from './helpers/world.js';

const LANGS = ['en', 'fr', 'de', 'es'];

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, language = 'en') {
  const ack = await w.fake.widgetGet('downloads', { settings: {}, language });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
}

test('the widget fits the budget in every state and language', async (t) => {
  const many = new FakeAria2();
  for (let i = 0; i < 12; i += 1) {
    many.add({
      status: 'active',
      totalLength: '1000',
      completedLength: String(i * 50),
      downloadSpeed: String(i * 1000),
      files: [{ path: `/downloads/a-very-long-file-name-for-the-tablet-${i}.mkv`, uris: [] }],
    });
  }
  const down = new FakeAria2();
  down.down = true;
  const worlds = [
    await world(t),
    await world(t, { aria2: many }),
    await world(t, { aria2: new FakeAria2({ downloads: [] }) }),
    await world(t, { aria2: down }),
    await world(t, { config: { language: 'en' } }),
  ];
  for (const w of worlds) {
    for (const language of LANGS) {
      assert.deepEqual(validateWidgetContent(await content(w, language)), [], language);
    }
  }
  const busy = await content(worlds[1]);
  const status = busy.components.find((c) => c.type === 'status');
  assert.equal(status.items.length, 8, '5 downloads and the 3 counters');
  assert.match(status.items[0].label, /…$/);
});

test('tiles, downloads and buttons of a busy aria2', async (t) => {
  const w = await world(t, { config: { ...CONFIG, language: 'fr' } });
  const { components } = await content(w, 'fr');
  assert.deepEqual(
    components.filter((c) => c.type === 'value').map((c) => [c.label, c.value, c.unit]),
    [
      ['Réception', 1.4, 'Mo/s'],
      ['Envoi', 0, 'ko/s'],
      ['Actifs', 2, undefined],
    ],
  );
  const rows = components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ['small.1.bin', '8 % · 80 ko/s'],
      ['big.iso', '0 % · 1,3 Mo/s'],
      ['Téléchargements en attente', 0],
      ['Téléchargements terminés', 1],
      ['Téléchargements en erreur', 1],
    ],
  );
  assert.deepEqual(
    components.filter((c) => c.type === 'button').map((c) => [c.label, c.icon, c.action]),
    [
      ['Tout en pause', 'pause', { key: 'pause_all' }],
      ['Tout reprendre', 'play', { key: 'resume_all' }],
      ['Ralentir', 'chevrons-down', { key: 'slow_down', params: { enabled: true } }],
    ],
  );
});

test('the buttons pause, resume and slow down; the check mark shows the limit', async (t) => {
  const w = await world(t, { config: { ...CONFIG, slow_limit: 300 } });
  let ack = await w.fake.widgetAction('downloads', 'pause_all', {}, { settings: {} });
  assert.equal(ack.data.message.en, 'Every download is paused.');
  assert.ok(w.aria2.calls.includes('aria2.pauseAll'));
  ack = await w.fake.widgetAction('downloads', 'resume_all', {}, { settings: {} });
  assert.equal(ack.data.message.fr, 'Tous les téléchargements reprennent.');
  ack = await w.fake.widgetAction('downloads', 'slow_down', { enabled: true }, { settings: {} });
  assert.equal(ack.data.message.de, 'Downloads auf 300 kB/s begrenzt.');
  assert.equal(w.aria2.limit, '300000');
  const slow = (await content(w)).components.find((c) => c.action?.key === 'slow_down');
  assert.equal(slow.icon, 'check-circle');
  assert.deepEqual(slow.action.params, { enabled: false });
  ack = await w.fake.widgetAction('downloads', 'slow_down', { enabled: false }, { settings: {} });
  assert.equal(ack.data.message.es, 'Límite de descarga eliminado.');
  assert.equal(w.aria2.limit, '0');
  ack = await w.fake.widgetAction('downloads', 'other', {}, { settings: {} });
  assert.equal(ack.success, false);
});

test('without an address, or when aria2 does not answer, the widget says so', async (t) => {
  const empty = await world(t, { config: { language: 'en' } });
  assert.match((await content(empty)).components[0].text, /RPC address of aria2/);
  const aria2 = new FakeAria2();
  aria2.down = true;
  const down = await world(t, { aria2 });
  const { components } = await content(down);
  assert.match(components[0].text, /aria2 does not answer/);
  assert.deepEqual(
    components.find((c) => c.type === 'status').items.map((r) => r.value),
    ['Unreachable'],
  );
});
