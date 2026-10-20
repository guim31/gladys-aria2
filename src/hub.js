// -----------------------------------------------------------------------------
// The aria2 hub: the configured server, read on a timer of the container (the
// interval chosen in the configuration) and right after each WebSocket
// notification of aria2, its states published to Gladys when they change,
// its scene events fired on transitions, and the commands of the switches,
// the widget and the scene actions.
//
// Gladys never polls the device (should_poll: false): the core scheduler
// does not poll a device created without should_poll
// (GladysAssistant/Gladys#3198, still in 5.2.1), the interval goes up to two
// minutes, and the scene events must fire even before the device is added.
// onPoll stays as a fallback.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { Aria2Client, ERROR_KINDS } from './aria2.js';
import { MAX_LIMIT_KBPS } from './config.js';
import { FEATURE_KEYS, buildDevice, deviceIds, deviceStates, serverName } from './devices.js';
import { allPaused, countDownloads, diffDownloads, toGigabytes } from './model.js';
import { Aria2Notifications } from './notifications.js';
import { ACTION_TEXT, CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'aria2-hub' });

export const WIDGET_KEY = 'downloads';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  COMPLETED: 'download_completed',
  FAILED: 'download_error',
  QUEUE_EMPTY: 'queue_empty',
});

export const HUB_TIMINGS = {
  // aria2 stopped answering: read again this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // Notifications come in bursts (a hundred links added at once): one reading
  // this long after the last one.
  notifyDelayMs: 1_000,
  // An unchanged value is published again after this long, so Gladys never
  // shows it as "no recent value" (48 h); well under the 12 h asked.
  heartbeatMs: 6 * 60 * 60_000,
};

// At most this many scene events per trigger and reading: a hundred links
// failing at once must not flood the core (300 events per minute).
export const MAX_EVENTS_PER_READING = 20;

// What aria2 can download from a link (a .torrent or .metalink URL included).
const URI_SCHEMES = /^(https?|ftp|sftp):\/\/[^\s]+$|^magnet:\?[^\s]+$/i;
const MAX_URI_LENGTH = 4096;

const signature = (server, config) =>
  JSON.stringify([server.url, server.secret, config.allowSelfSigned]);

export class Aria2Hub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {Function} [options.request] HTTP seam (src/http.js)
   * @param {Function|null} [options.createSocket] WebSocket seam; null: no notifications
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, request, createSocket, timers = true, timings, now }) {
    this.gladys = gladys;
    this.request = request;
    this.createSocket = createSocket;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.record = null;
    this.transport = null;
    this.connection = null;
    this.pollTimer = null;
    this.stopped = false;
    /** Problems already logged, by key: their repeats go to debug. */
    this.warned = new Set();
  }

  // --- Logs ------------------------------------------------------------------
  // Info keeps the lifecycle only (connected, lost, back, user commands). A
  // problem that repeats every cycle is logged once at its own level, then at
  // debug until it clears. LOG_LEVEL=debug shows everything.

  problem(key, message, err, level = 'warn') {
    const args = err === undefined ? [message] : [message, err];
    if (this.warned.has(key)) {
      logger.debug(...args);
      return;
    }
    this.warned.add(key);
    logger[level](...args);
  }

  resolved(key) {
    this.warned.delete(key);
  }

  label(record) {
    return `aria2 (${serverName(record.server)})`;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates();
    this.transport = null;
    this.connection = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.config && this.config.language !== config.language;
    this.config = config;
    const { server } = config;
    if (this.record && (!server || this.record.signature !== signature(server, config))) {
      this.dropRecord(this.record);
      this.record = null;
    }
    if (server && this.record) {
      this.record.server = server; // a new name: same connection
      if (languageChanged) {
        // The downloads text is written in the language of the configuration.
        this.gladys.forgetPublishedStates(deviceIds(this.gladys).device);
      }
    } else if (server) {
      this.record = this.newRecord(server, config);
    }
    await this.publishDevices();
    await this.pollAll();
    this.schedulePoll();
  }

  newRecord(server, config) {
    const record = {
      server,
      signature: signature(server, config),
      api: new Aria2Client(server, { insecure: config.allowSelfSigned, request: this.request }),
      reading: null,
      connected: null,
      error: null,
      failures: 0,
      downSince: null,
      memory: { known: new Map(), pending: null },
      baseline: true,
      polling: null,
      retryTimer: null,
      notifyTimer: null,
      notifications: null,
      dropped: false,
    };
    if (this.createSocket !== null) {
      record.notifications = new Aria2Notifications({
        url: server.wsUrl,
        createSocket: this.createSocket,
        timers: this.timersEnabled,
        onNotify: (method) => this.onNotify(record, method),
        onState: (open) =>
          logger.debug(`${this.label(record)}: notifications ${open ? 'on' : 'off'}`),
      });
      record.notifications.start();
    }
    return record;
  }

  dropRecord(record) {
    record.dropped = true;
    clearTimeout(record.retryTimer);
    clearTimeout(record.notifyTimer);
    record.notifications?.stop();
    this.gladys.forgetPublishedStates(deviceIds(this.gladys).device);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    if (this.record) {
      clearTimeout(this.record.retryTimer);
      clearTimeout(this.record.notifyTimer);
      this.record.notifications?.stop();
    }
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.record) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.resolved('poll');
      } catch (err) {
        this.problem('poll', 'Reading failed', err, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  /** aria2 says a download changed: read it again soon (once per burst). */
  onNotify(record, method) {
    if (record.dropped || this.stopped) {
      return;
    }
    logger.debug(`${this.label(record)}: ${method}`);
    if (!this.timersEnabled) {
      this.refresh(record);
      return;
    }
    clearTimeout(record.notifyTimer);
    record.notifyTimer = setTimeout(() => this.refresh(record), this.timings.notifyDelayMs);
    record.notifyTimer.unref?.();
  }

  /** A fresh reading: after the one in progress, which may predate the change. */
  refresh(record) {
    return (record.polling ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.poll(record))
      .then((changed) => this.afterChanges(changed))
      .then(() => this.resolved('refresh'))
      .catch((err) => this.problem('refresh', 'Reading failed', err, 'error'));
  }

  // --- Devices -----------------------------------------------------------------

  async publishDevices() {
    const devices = this.record
      ? [buildDevice(this.gladys, this.record.server, this.config.language)]
      : [];
    // Even an empty list: the Discovery tab then shows no stale server.
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** "Search" in the Discovery tab: publish the device again, read aria2. */
  async rediscover() {
    await this.publishDevices();
    await this.pollAll();
  }

  /** Whether a device external id is ours, with a configured server. */
  isOurs(externalId) {
    return Boolean(this.record) && externalId === deviceIds(this.gladys).device;
  }

  /** The user added the device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    if (!this.isOurs(device.external_id)) {
      return;
    }
    // The SDK forgot the values of this device: everything goes again.
    this.gladys.forgetPublishedStates(device.external_id);
    await this.publishStates(this.record);
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Reading aria2 -------------------------------------------------------------

  async pollAll() {
    const changed = this.record ? await this.poll(this.record) : false;
    await this.afterChanges(changed);
  }

  /** Gladys asks for a refresh (onPoll). */
  async pollDevice(device) {
    if (this.isOurs(device.external_id)) {
      await this.pollAll();
    }
  }

  /**
   * Read aria2 and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll(record) {
    record.polling ??= this.read(record).finally(() => {
      record.polling = null;
    });
    return record.polling;
  }

  async read(record) {
    let reading;
    try {
      reading = await record.api.read();
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      return this.applyFailure(record, err);
    }
    return this.applySuccess(record, reading);
  }

  async applySuccess(record, reading) {
    if (record.dropped) {
      return false;
    }
    if (record.downSince !== null) {
      const minutes = Math.round((this.now() - record.downSince) / 60_000);
      logger.info(`${this.label(record)} answers again after ${minutes} min`);
    } else if (record.error) {
      logger.info(`${this.label(record)}: connection restored`);
    } else if (record.connected === null) {
      const version = reading.version ? ` ${reading.version}` : '';
      logger.info(
        `${this.label(record)}: connected to aria2${version}, ${reading.downloads.length} download(s)`,
      );
    }
    const previous = record.reading;
    const widgetChanged =
      record.connected !== true || record.error !== null || changedForWidget(previous, reading);
    record.connected = true;
    record.error = null;
    record.failures = 0;
    record.downSince = null;
    record.reading = reading;

    const { completed, failed, queueEmpty } = diffDownloads(
      record.memory,
      reading.downloads,
      record.baseline,
    );
    record.baseline = false;
    await this.fireEvents(record, TRIGGERS.COMPLETED, completed, (d) => ({
      name: d.name.slice(0, 1000),
      size_gb: toGigabytes(d.total),
      dir: d.dir.slice(0, 1000),
    }));
    await this.fireEvents(record, TRIGGERS.FAILED, failed, (d) => ({
      name: d.name.slice(0, 1000),
      error_code: d.errorCode ?? 0,
      error: d.errorMessage.slice(0, 1000),
    }));
    if (queueEmpty) {
      const counts = countDownloads(reading.downloads);
      await this.fireEvents(record, TRIGGERS.QUEUE_EMPTY, [null], () => ({
        completed: counts.completed,
        errors: counts.errors,
      }));
    }

    await this.publishStates(record);
    return widgetChanged || completed.length > 0 || failed.length > 0;
  }

  async applyFailure(record, err) {
    if (record.dropped) {
      return false;
    }
    const wasError = record.error?.kind;
    record.error = { kind: err.kind, message: err.message };
    // One warning when the problem starts (or changes), not one per reading.
    if (wasError !== err.kind) {
      logger.warn(`${this.label(record)}: ${err.message}`);
    } else {
      logger.debug(`${this.label(record)}: ${err.message} (again)`);
    }
    const wasConnected = record.connected;
    record.connected = false;
    if (err.kind === ERROR_KINDS.UNREACHABLE) {
      record.failures += 1;
      if (record.failures === 1) {
        record.downSince = this.now();
        this.scheduleRetry(record);
      }
    } else {
      // A refused secret is a configuration problem, not an outage.
      record.failures = 0;
      record.downSince = null;
    }
    await this.publishStates(record);
    return wasError !== err.kind || wasConnected !== false;
  }

  scheduleRetry(record) {
    clearTimeout(record.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    record.retryTimer = setTimeout(() => this.refresh(record), this.timings.retryMs);
    record.retryTimer.unref?.();
  }

  /** One scene event per item, at most MAX_EVENTS_PER_READING per reading. */
  async fireEvents(record, key, items, data) {
    const kept = items.slice(0, MAX_EVENTS_PER_READING);
    if (items.length > kept.length) {
      logger.debug(
        `${this.label(record)}: ${items.length - kept.length} ${key} event(s) not sent (too many at once)`,
      );
    }
    for (const item of kept) {
      logger.debug(`${this.label(record)}: ${key}${item ? ` "${item.name}"` : ''}`);
      try {
        await this.gladys.publishSceneEvent(key, data(item));
        this.resolved('scene-event');
      } catch (err) {
        this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
      }
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  async publishStates(record) {
    const states = deviceStates(this.gladys, {
      reading: record.reading,
      connected: record.connected,
      language: this.config.language,
    });
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.resolved('states');
    } catch (err) {
      this.problem('states', `States of ${this.label(record)} refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged) {
    await this.publishTransport();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  async publishTransport() {
    const record = this.record;
    if (!record || record.connected === null) {
      return;
    }
    const transport = record.connected ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    if (this.transport === transport) {
      return;
    }
    try {
      await this.gladys.publishTransports([
        { external_id: deviceIds(this.gladys).device, transport },
      ]);
      this.transport = transport;
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    const { record } = this;
    if (!record) {
      return {
        connected: false,
        message: this.config.invalidUrl ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.noServer,
      };
    }
    if (!record.error) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noServer)) {
      message[language] = labelled(
        serverName(record.server),
        pick(ERROR_TEXT[record.error.kind], language),
        language,
      ).slice(0, 200);
    }
    return { connected: false, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  // --- Commands --------------------------------------------------------------------------

  /** The configured server, or an error in the configured language. */
  target() {
    if (!this.record) {
      throw new Error(pick(ACTION_TEXT.noServer, this.config?.language));
    }
    return this.record;
  }

  /**
   * Run a command, then read aria2 again.
   * @returns {Promise<unknown>} what the command returned
   */
  async command(what, run) {
    const record = this.target();
    let result;
    try {
      result = await run(record.api);
      logger.info(`${this.label(record)}: ${what}`);
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      logger.warn(`${this.label(record)}: ${what} failed: ${err.message}`);
      const language = this.config.language;
      throw new Error(
        labelled(
          serverName(record.server),
          pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT[ERROR_KINDS.HTTP], language),
          language,
        ),
        { cause: err },
      );
    }
    // The new state, without waiting for the next reading (after the one in
    // progress, if any: it may have started before the command).
    await record.polling?.catch(() => {});
    await this.poll(record);
    await this.afterChanges(true);
    return result;
  }

  pauseAll() {
    return this.command('every download paused', (api) => api.pauseAll());
  }

  resumeAll() {
    return this.command('every download resumed', (api) => api.resumeAll());
  }

  /**
   * The global download limit, in kB/s (0 = none).
   * @param {unknown} raw
   */
  setDownloadLimit(raw) {
    const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : raw;
    const limit = typeof text === 'string' && text === '' ? NaN : Number(text);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT_KBPS) {
      throw new Error(pick(ACTION_TEXT.badLimit, this.config?.language));
    }
    return this.command(
      limit === 0 ? 'download limit removed' : `download limit set to ${limit} kB/s`,
      (api) => api.setDownloadLimit(limit * 1000),
    );
  }

  /** "Slow down": the limit of the configuration, or none. */
  slowDown(enabled) {
    return this.setDownloadLimit(enabled ? this.config.slowLimitKbps : 0);
  }

  /**
   * Add a link (http, https, ftp, sftp, magnet; a .torrent or .metalink URL
   * is followed by aria2), in the default folder of aria2 or in `dir`.
   * @returns {Promise<string>} the gid of the new download
   */
  addUri(rawUri, rawDir) {
    const language = this.config?.language;
    const uri = typeof rawUri === 'string' ? rawUri.trim() : '';
    if (!URI_SCHEMES.test(uri) || uri.length > MAX_URI_LENGTH) {
      throw new Error(pick(ACTION_TEXT.badUri, language));
    }
    const dir = typeof rawDir === 'string' ? rawDir.trim() : '';
    // An absolute folder, not a way out of it: the scene author picks where
    // aria2 writes, never somewhere relative to its working directory.
    if (dir && (!dir.startsWith('/') || dir.split('/').includes('..') || dir.length > 1000)) {
      throw new Error(pick(ACTION_TEXT.badDir, language));
    }
    // The link may carry a token: the log keeps its host only.
    const shown = uri.startsWith('magnet:') ? 'a magnet link' : `a link to ${new URL(uri).host}`;
    return this.command(`${shown} added`, (api) => api.addUri(uri, dir || null));
  }

  /** The two switches of the device. */
  async setValue(device, feature, value) {
    if (this.isOurs(device.external_id)) {
      const ids = deviceIds(this.gladys);
      const on = Number(value) === 1;
      if (feature.external_id === ids.feature(FEATURE_KEYS.PAUSED)) {
        await (on ? this.pauseAll() : this.resumeAll());
        return;
      }
      if (feature.external_id === ids.feature(FEATURE_KEYS.SLOW_DOWN)) {
        await this.slowDown(on);
        return;
      }
    }
    throw new Error(`Feature ${feature.external_id} cannot be controlled`);
  }

  // --- Reports -------------------------------------------------------------------------------

  /** "Test the connection": read aria2 now, one line. */
  async testConnection() {
    await this.pollAll();
    const { record } = this;
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (!record) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      const name = serverName(record.server);
      if (record.error) {
        message[language] = labelled(name, pick(ERROR_TEXT[record.error.kind], language), language);
        continue;
      }
      const { version, downloads } = record.reading;
      const counts = countDownloads(downloads);
      const parts = [
        text.ok,
        `aria2${version ? ` ${version}` : ''}`,
        text.downloads(counts.active, counts.waiting),
      ];
      if (record.notifications) {
        parts.push(record.notifications.open ? text.notifications : text.polling);
      }
      message[language] = labelled(name, parts.join(', '), language);
    }
    return message;
  }
}

/**
 * Whether the widget needs a refresh: the counters, the switches. Not the
 * speeds or the percentages: they move at every reading, and the widget's
 * own refresh (30 s) follows them.
 */
function changedForWidget(previous, next) {
  if (!previous) {
    return true;
  }
  const a = countDownloads(previous.downloads);
  const b = countDownloads(next.downloads);
  return (
    a.active !== b.active ||
    a.waiting !== b.waiting ||
    a.completed !== b.completed ||
    a.errors !== b.errors ||
    allPaused(a) !== allPaused(b) ||
    previous.downloadLimit !== next.downloadLimit
  );
}
