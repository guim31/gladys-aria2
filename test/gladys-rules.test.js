// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on the device discovered from realistic
// fixtures (answers recorded on aria2 1.37.0, test/fixtures/aria2/): busy,
// paused, finished and empty sessions, before and after a reading, in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled and guim31/gladys-torrent.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONFIG, FakeAria2, createWorld } from './helpers/world.js';
import { DONE, downloadsOf } from './helpers/fakeAria2.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const paused = () => {
  const aria2 = new FakeAria2();
  aria2.limit = '2000000';
  for (const d of aria2.downloads) {
    if (d.status === 'active') {
      d.status = 'paused';
    }
  }
  return aria2;
};

const scenarios = [
  { label: 'downloads in progress', aria2: () => new FakeAria2() },
  { label: 'everything paused, slowed down', aria2: paused },
  { label: 'session over', aria2: () => new FakeAria2({ downloads: downloadsOf(DONE) }) },
  { label: 'nothing at all', aria2: () => new FakeAria2({ downloads: [] }) },
  { label: 'no secret', aria2: () => new FakeAria2({ secret: '' }), config: { rpc_secret: '' } },
  { label: 'French names', aria2: () => new FakeAria2(), config: { language: 'fr' } },
  { label: 'German names', aria2: () => new FakeAria2(), config: { language: 'de' } },
  { label: 'Spanish names', aria2: () => new FakeAria2(), config: { language: 'es' } },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const { gladys, app } = await createWorld({
      aria2: scenario.aria2(),
      config: { ...CONFIG, ...scenario.config },
    });
    try {
      const devices = gladys.fake.discoveredDevices;
      assert.equal(devices.length, 1);
      assert.equal(new Set(devices.map((d) => d.external_id)).size, devices.length);
      assert.equal(new Set(devices.map((d) => d.name)).size, devices.length, 'distinct names');

      for (const device of devices) {
        const where = device.name;

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
            const allowed = table.units_by_category[feature.category];
            if (allowed) {
              assert.ok(
                allowed.includes(feature.unit),
                `${at}: ${feature.unit} for ${feature.category}`,
              );
            }
          }

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);

          // The value read from the fixtures fits the declared bounds.
          const last = gladys.fake.states.findLast(
            (state) => state.device_feature_external_id === feature.external_id,
          );
          assert.ok(last, `${at}: no state published`);
          if (feature.category === 'text') {
            assert.equal(typeof last.text, 'string', `${at}: a text state`);
            assert.ok(last.text.length > 0 && last.text.length <= 255, `${at}: text length`);
            continue;
          }
          const value = last.state;
          assert.equal(typeof value, 'number', `${at}: no numeric state`);
          assert.ok(value >= feature.min && value <= feature.max, `${at}: ${value} out of bounds`);
          if (['integer', 'binary'].includes(feature.type)) {
            assert.ok(Number.isInteger(value), `${at}: ${value} is not an integer`);
          }
        }
      }
    } finally {
      await app.stop();
    }
  });
}
