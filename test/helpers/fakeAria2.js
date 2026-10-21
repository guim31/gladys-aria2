// -----------------------------------------------------------------------------
// An in-memory aria2: the JSON-RPC methods the integration calls, answering
// like aria2 1.37.0 does (shapes and errors recorded in test/fixtures/aria2/,
// see CLAUDE.md), behind the HTTP seam of src/http.js, plus a fake WebSocket
// that pushes its notifications.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/aria2/${name}.json`, import.meta.url), 'utf8'));

export const BUSY = fixture('busy');
export const DONE = fixture('done');
export const VERSION = fixture('empty').result[0][0];

/** The downloads of a recorded multicall answer, in aria2 order. */
export const downloadsOf = (answer) => [
  ...answer.result[3][0],
  ...answer.result[4][0],
  ...answer.result[5][0],
];

const pickKeys = (download, keys) =>
  Array.isArray(keys)
    ? Object.fromEntries(keys.filter((k) => k in download).map((k) => [k, download[k]]))
    : download;

const unauthorized = { code: 1, message: 'Unauthorized' };

export class FakeAria2 {
  /**
   * @param {object} [options]
   * @param {string} [options.secret]
   * @param {Array} [options.downloads] raw aria2 downloads (default: the busy fixture)
   */
  constructor({ secret = 'secret', downloads = downloadsOf(BUSY) } = {}) {
    this.secret = secret;
    this.downloads = structuredClone(downloads);
    this.limit = '0';
    this.down = false;
    this.html = false;
    this.calls = [];
    this.sockets = new Set();
    this.nextGid = 1;
  }

  // --- Test helpers ------------------------------------------------------------

  get(gid) {
    return this.downloads.find((d) => d.gid === gid);
  }

  set(gid, patch) {
    Object.assign(this.get(gid), patch);
  }

  add(raw) {
    const download = {
      gid: raw.gid ?? `00000000000000${String(this.nextGid++).padStart(2, '0')}`,
      status: 'waiting',
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      uploadSpeed: '0',
      dir: '/downloads',
      files: [],
      ...raw,
    };
    this.downloads.push(download);
    return download;
  }

  complete(gid) {
    const d = this.get(gid);
    Object.assign(d, {
      status: 'complete',
      completedLength: d.totalLength,
      downloadSpeed: '0',
      errorCode: '0',
    });
    this.notify('aria2.onDownloadComplete', gid);
  }

  fail(gid, errorCode = '3', errorMessage = 'Resource not found') {
    Object.assign(this.get(gid), { status: 'error', downloadSpeed: '0', errorCode, errorMessage });
    this.notify('aria2.onDownloadError', gid);
  }

  remove(gid) {
    this.set(gid, { status: 'removed', downloadSpeed: '0' });
  }

  /** Push a notification on every open WebSocket. */
  notify(method, gid) {
    for (const socket of this.sockets) {
      socket.emit('message', {
        data: JSON.stringify({ jsonrpc: '2.0', method, params: [{ gid }] }),
      });
    }
  }

  // --- The JSON-RPC server ---------------------------------------------------------

  list(...statuses) {
    return this.downloads.filter((d) => statuses.includes(d.status));
  }

  run(method, params) {
    const [token, ...args] = params;
    if (this.secret && token !== `token:${this.secret}`) {
      return { error: unauthorized };
    }
    const rest = this.secret ? args : params;
    switch (method) {
      case 'aria2.getVersion':
        return { result: VERSION };
      case 'aria2.getGlobalStat': {
        const active = this.list('active');
        const sum = (key) => active.reduce((total, d) => total + Number(d[key] ?? 0), 0);
        return {
          result: {
            downloadSpeed: String(sum('downloadSpeed')),
            uploadSpeed: String(sum('uploadSpeed')),
            numActive: String(active.length),
            numWaiting: String(this.list('waiting', 'paused').length),
            numStopped: String(this.list('complete', 'error', 'removed').length),
            numStoppedTotal: String(this.list('complete', 'error', 'removed').length),
          },
        };
      }
      case 'aria2.getGlobalOption':
        return { result: { dir: '/downloads', 'max-overall-download-limit': this.limit } };
      case 'aria2.tellActive':
        return { result: this.list('active').map((d) => pickKeys(d, rest[0])) };
      case 'aria2.tellWaiting':
        return {
          result: this.list('waiting', 'paused')
            .slice(rest[0], rest[0] + rest[1])
            .map((d) => pickKeys(d, rest[2])),
        };
      case 'aria2.tellStopped': {
        // A negative offset counts from the end, newest first (like aria2).
        const stopped = this.list('complete', 'error', 'removed');
        const list = rest[0] < 0 ? stopped.reverse() : stopped;
        const from = rest[0] < 0 ? -rest[0] - 1 : rest[0];
        return {
          result: list.slice(from, from + rest[1]).map((d) => pickKeys(d, rest[2])),
        };
      }
      case 'aria2.pauseAll':
        for (const d of this.list('active', 'waiting')) {
          Object.assign(d, { status: 'paused', downloadSpeed: '0' });
        }
        return { result: 'OK' };
      case 'aria2.unpauseAll':
        for (const d of this.list('paused')) {
          d.status = 'waiting';
        }
        return { result: 'OK' };
      case 'aria2.changeGlobalOption':
        if ('max-overall-download-limit' in rest[0]) {
          this.limit = rest[0]['max-overall-download-limit'];
        }
        return { result: 'OK' };
      case 'aria2.addUri': {
        const [uris, options = {}] = rest;
        if (!Array.isArray(uris) || !/^[a-z]+:/.test(uris[0] ?? '')) {
          return { error: { code: 1, message: 'No URI to download.' } };
        }
        const download = this.add({
          dir: options.dir ?? '/downloads',
          files: [{ path: '', uris: [{ status: 'waiting', uri: uris[0] }] }],
        });
        return { result: download.gid };
      }
      default:
        return { error: { code: 1, message: `No such method: ${method}` } };
    }
  }

  /** The HTTP seam: (url, options) => { status, headers, body }. */
  request = async (url, { method, body }) => {
    if (this.down) {
      const error = new Error('connect ECONNREFUSED');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    if (this.html || method !== 'POST' || !url.endsWith('/jsonrpc')) {
      return { status: 404, headers: {}, body: '<html>Not Found</html>' };
    }
    const call = JSON.parse(body);
    this.calls.push(
      call.method === 'system.multicall' ? call.params[0].map((c) => c.methodName) : call.method,
    );
    if (call.method === 'system.multicall') {
      const result = call.params[0].map(({ methodName, params }) => {
        const answer = this.run(methodName, params);
        return answer.error ?? [answer.result];
      });
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ id: call.id, jsonrpc: '2.0', result }),
      };
    }
    const answer = this.run(call.method, call.params);
    return {
      status: answer.error ? 400 : 200,
      headers: {},
      body: JSON.stringify({ id: call.id, jsonrpc: '2.0', ...answer }),
    };
  };

  /** The WebSocket seam: (url) => a WebSocket-like object. */
  createSocket = (url) => {
    const listeners = {};
    const socket = {
      url,
      addEventListener: (type, fn) => {
        (listeners[type] ??= []).push(fn);
      },
      emit: (type, event = {}) => {
        for (const fn of listeners[type] ?? []) {
          fn(event);
        }
      },
      close: () => {
        if (this.sockets.delete(socket)) {
          socket.emit('close');
        }
      },
    };
    if (this.down) {
      queueMicrotask(() => {
        socket.emit('error');
        socket.emit('close');
      });
      return socket;
    }
    this.sockets.add(socket);
    queueMicrotask(() => socket.emit('open'));
    return socket;
  };
}
