// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, an in-memory aria2 and a
// manual clock, with the integration wired on top through registerHandlers.
// No timer runs unless `timers: true` (with node:test mock timers): the tests
// read aria2 with `world.hub.pollAll()`. (Adapted from guim31/gladys-torrent.)
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { FakeAria2 } from './fakeAria2.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const CONFIG = {
  rpc_url: '192.0.2.10',
  rpc_secret: 'secret',
  name: 'NAS',
  language: 'en',
};

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 20, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * @param {object} [options]
 * @param {FakeAria2} [options.aria2]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.sockets] WebSocket notifications (on by default)
 */
export async function createWorld({
  clock = createClock(),
  aria2 = new FakeAria2(),
  config = CONFIG,
  devices = [],
  connect = true,
  timings = {},
  timers = false,
  sockets = true,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    request: aria2.request,
    createSocket: sockets ? aria2.createSocket : null,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, aria2, app, hub: app.hub, clock };
}

/** External ids of the device. */
export const ids = (gladys) => gladys.externalIds('aria2', 'server');

/** Add the discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

/** Let the queued microtasks and promises run (fake WebSocket, notifications). */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export { FakeAria2 };
