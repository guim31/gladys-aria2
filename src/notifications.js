// -----------------------------------------------------------------------------
// The WebSocket of aria2 (same port and path as the HTTP RPC): aria2 pushes
// a notification when a download starts, pauses, stops, completes or fails
// (aria2.onDownloadStart|Pause|Stop|Complete|Error, onBtDownloadComplete).
// A notification only says "something changed": the hub reads aria2 again
// (src/hub.js), so the scene triggers fire within a second instead of at the
// refresh interval, and a lost notification is caught by the next reading.
//
// Reconnects on its own, with a growing delay (5 s to 5 min). Never needed:
// without the WebSocket (a proxy that does not pass it, a self-signed
// certificate), the readings of the timer still see everything.
// -----------------------------------------------------------------------------

export const NOTIFICATION_METHODS = new Set([
  'aria2.onDownloadStart',
  'aria2.onDownloadPause',
  'aria2.onDownloadStop',
  'aria2.onDownloadComplete',
  'aria2.onDownloadError',
  'aria2.onBtDownloadComplete',
]);

export const NOTIFY_TIMINGS = {
  minRetryMs: 5_000,
  maxRetryMs: 5 * 60_000,
};

export class Aria2Notifications {
  /**
   * @param {object} options
   * @param {string} options.url ws:// or wss:// URL
   * @param {() => void} options.onNotify a download changed
   * @param {(open: boolean) => void} [options.onState] the socket opened or closed
   * @param {Function} [options.createSocket] (url) => WebSocket-like (tests)
   * @param {boolean} [options.timers] reconnection timers (off in tests)
   * @param {object} [options.timings]
   */
  constructor({ url, onNotify, onState = () => {}, createSocket, timers = true, timings }) {
    this.url = url;
    this.onNotify = onNotify;
    this.onState = onState;
    this.createSocket = createSocket ?? ((target) => new WebSocket(target));
    this.timersEnabled = timers;
    this.timings = { ...NOTIFY_TIMINGS, ...timings };
    this.socket = null;
    this.open = false;
    this.retryMs = this.timings.minRetryMs;
    this.retryTimer = null;
    this.stopped = false;
  }

  start() {
    if (this.stopped || this.socket) {
      return;
    }
    let socket;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.open = true;
      this.retryMs = this.timings.minRetryMs;
      this.onState(true);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) {
        return;
      }
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (NOTIFICATION_METHODS.has(message?.method)) {
        this.onNotify(message.method);
      }
    });
    // `error` is always followed by `close`.
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (this.open) {
        this.open = false;
        this.onState(false);
      }
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    if (this.stopped || !this.timersEnabled) {
      return;
    }
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.timings.maxRetryMs);
    this.retryTimer = setTimeout(() => this.start(), delay);
    this.retryTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }
}
