// -----------------------------------------------------------------------------
// One Gladys device: the aria2 server.
//
// Identity: `aria2:server`, not the address: moving aria2 to another port or
// to HTTPS keeps the device and its history. aria2 exposes no stable
// instance id to use instead, and the integration follows one server.
//
// Features (category/type couples of the core table, see
// test/gladys-rules.test.js):
//   - download and upload speeds: datarate/rate, in kB/s, rounded;
//   - active, waiting, completed and failed downloads: counter-sensor/integer
//     (src/model.js);
//   - current downloads: text/text, the first three with their percentage;
//   - pause everything: switch/binary, writable (1 = everything left is paused);
//   - slow down: switch/binary, writable (1 = a global download limit is set,
//     the one of the configuration when the switch sets it);
//   - download speed limit: datarate/rate, in kB/s, 0 = none;
//   - connected: input/binary, 1 while aria2 answers.
//
// The device is published with should_poll: false: the integration reads
// aria2 on its own timer (src/hub.js), at the interval chosen in the
// configuration (GladysAssistant/Gladys#3198: a device created without
// should_poll is never polled, and the interval can be 2 minutes).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { hostOf } from './config.js';
import { allPaused, countDownloads, downloadsText, toKilobytesPerSecond } from './model.js';
import { NO_DOWNLOAD } from './texts.js';

export const URL_PARAM = 'ARIA2_RPC_URL';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  DOWNLOAD_SPEED: 'download_speed',
  UPLOAD_SPEED: 'upload_speed',
  ACTIVE: 'downloads_active',
  WAITING: 'downloads_waiting',
  COMPLETED: 'downloads_completed',
  ERRORS: 'downloads_error',
  DOWNLOADS: 'current_downloads',
  PAUSED: 'paused',
  SLOW_DOWN: 'slow_down',
  DOWNLOAD_LIMIT: 'download_limit',
  CONNECTED: 'connected',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Download speed',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Upload speed',
    [FEATURE_KEYS.ACTIVE]: 'Active downloads',
    [FEATURE_KEYS.WAITING]: 'Waiting downloads',
    [FEATURE_KEYS.COMPLETED]: 'Completed downloads',
    [FEATURE_KEYS.ERRORS]: 'Failed downloads',
    [FEATURE_KEYS.DOWNLOADS]: 'Current downloads',
    [FEATURE_KEYS.PAUSED]: 'Pause all',
    [FEATURE_KEYS.SLOW_DOWN]: 'Slow down',
    [FEATURE_KEYS.DOWNLOAD_LIMIT]: 'Download speed limit',
    [FEATURE_KEYS.CONNECTED]: 'aria2 connected',
  },
  fr: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Débit descendant',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Débit montant',
    [FEATURE_KEYS.ACTIVE]: 'Téléchargements actifs',
    [FEATURE_KEYS.WAITING]: 'Téléchargements en attente',
    [FEATURE_KEYS.COMPLETED]: 'Téléchargements terminés',
    [FEATURE_KEYS.ERRORS]: 'Téléchargements en erreur',
    [FEATURE_KEYS.DOWNLOADS]: 'Téléchargements en cours',
    [FEATURE_KEYS.PAUSED]: 'Tout en pause',
    [FEATURE_KEYS.SLOW_DOWN]: 'Ralentir',
    [FEATURE_KEYS.DOWNLOAD_LIMIT]: 'Limite de débit descendant',
    [FEATURE_KEYS.CONNECTED]: 'aria2 connecté',
  },
  de: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Download-Geschwindigkeit',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Upload-Geschwindigkeit',
    [FEATURE_KEYS.ACTIVE]: 'Aktive Downloads',
    [FEATURE_KEYS.WAITING]: 'Wartende Downloads',
    [FEATURE_KEYS.COMPLETED]: 'Fertige Downloads',
    [FEATURE_KEYS.ERRORS]: 'Fehlgeschlagene Downloads',
    [FEATURE_KEYS.DOWNLOADS]: 'Aktuelle Downloads',
    [FEATURE_KEYS.PAUSED]: 'Alle pausieren',
    [FEATURE_KEYS.SLOW_DOWN]: 'Drosseln',
    [FEATURE_KEYS.DOWNLOAD_LIMIT]: 'Download-Limit',
    [FEATURE_KEYS.CONNECTED]: 'aria2 verbunden',
  },
  es: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Velocidad de descarga',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Velocidad de subida',
    [FEATURE_KEYS.ACTIVE]: 'Descargas activas',
    [FEATURE_KEYS.WAITING]: 'Descargas en espera',
    [FEATURE_KEYS.COMPLETED]: 'Descargas completadas',
    [FEATURE_KEYS.ERRORS]: 'Descargas con error',
    [FEATURE_KEYS.DOWNLOADS]: 'Descargas en curso',
    [FEATURE_KEYS.PAUSED]: 'Pausar todo',
    [FEATURE_KEYS.SLOW_DOWN]: 'Frenar',
    [FEATURE_KEYS.DOWNLOAD_LIMIT]: 'Límite de descarga',
    [FEATURE_KEYS.CONNECTED]: 'aria2 conectado',
  },
};

// Display bounds (the core never applies them on write).
const MAX_SPEED_KBPS = 10_000_000; // 10 GB/s
const MAX_DOWNLOADS = 1_000_000;

const sensor = (category, type, max, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max,
  ...extra,
});

const rate = (value) => ({
  definition: sensor(
    DEVICE_FEATURE_CATEGORIES.DATARATE,
    DEVICE_FEATURE_TYPES.DATARATE.RATE,
    MAX_SPEED_KBPS,
    { unit: DEVICE_FEATURE_UNITS.KILOBYTES_PER_SECOND },
  ),
  value,
});

const counter = (key) => ({
  definition: sensor(
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    MAX_DOWNLOADS,
  ),
  value: (r) => (r ? countDownloads(r.downloads)[key] : null),
});

const toggle = (value) => ({
  definition: {
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    min: 0,
    max: 1,
  },
  value,
});

// Order = display order in Gladys. `value(reading, language)` returns a
// number, `{ text }` for the text feature, or null (nothing to publish).
const FEATURES = {
  [FEATURE_KEYS.DOWNLOAD_SPEED]: rate((r) => (r ? toKilobytesPerSecond(r.downloadSpeed) : null)),
  [FEATURE_KEYS.UPLOAD_SPEED]: rate((r) => (r ? toKilobytesPerSecond(r.uploadSpeed) : null)),
  [FEATURE_KEYS.ACTIVE]: counter('active'),
  [FEATURE_KEYS.WAITING]: counter('waiting'),
  [FEATURE_KEYS.COMPLETED]: counter('completed'),
  [FEATURE_KEYS.ERRORS]: counter('errors'),
  [FEATURE_KEYS.DOWNLOADS]: {
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      // NOT NULL in the core, even for a text: 0/0 like Zigbee2MQTT.
      min: 0,
      max: 0,
    },
    value: (r, language) =>
      r
        ? { text: downloadsText(r.downloads, language, NO_DOWNLOAD[language] ?? NO_DOWNLOAD.en) }
        : null,
  },
  [FEATURE_KEYS.PAUSED]: toggle((r) => (r ? Number(allPaused(countDownloads(r.downloads))) : null)),
  [FEATURE_KEYS.SLOW_DOWN]: toggle((r) => (r ? Number(r.downloadLimit > 0) : null)),
  [FEATURE_KEYS.DOWNLOAD_LIMIT]: rate((r) => (r ? toKilobytesPerSecond(r.downloadLimit) : null)),
  [FEATURE_KEYS.CONNECTED]: {
    definition: sensor(DEVICE_FEATURE_CATEGORIES.INPUT, DEVICE_FEATURE_TYPES.SENSOR.BINARY, 1),
    // Published from the connection state, not from a reading.
    value: () => null,
  },
};

/** External ids of the device and its features. */
export const deviceIds = (gladys) => gladys.externalIds('aria2', 'server');

/** The name shown for the server: the one typed in the configuration, else aria2 and the address. */
export const serverName = (server) => server.name ?? `aria2 ${hostOf(server.url)}`;

/**
 * The discovery payload of the server.
 * @param {object} gladys SDK client
 * @param {{ url: string, name: string|null }} server
 * @param {string} language feature names language
 */
export function buildDevice(gladys, server, language = 'en') {
  const ids = deviceIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: serverName(server),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: URL_PARAM, value: server.url }],
    features: Object.entries(FEATURES).map(([key, feature]) => ({
      ...feature.definition,
      name: names[key],
      external_id: ids.feature(key),
    })),
  };
}

/**
 * The states of the server, in the publishStates format.
 * @param {object} gladys
 * @param {{ reading: object|null, connected: boolean|null, language: string }} state
 */
export function deviceStates(gladys, { reading, connected, language }) {
  const ids = deviceIds(gladys);
  const states = [];
  for (const [key, feature] of Object.entries(FEATURES)) {
    const value =
      key === FEATURE_KEYS.CONNECTED
        ? connected === null
          ? null
          : Number(connected)
        : feature.value(reading, language);
    if (value === null || value === undefined) {
      continue;
    }
    states.push(
      typeof value === 'object'
        ? { device_feature_external_id: ids.feature(key), text: value.text }
        : { device_feature_external_id: ids.feature(key), state: value },
    );
  }
  return states;
}
