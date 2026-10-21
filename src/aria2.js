// -----------------------------------------------------------------------------
// What the integration reads from aria2 and the commands it sends, on top of
// the JSON-RPC client (src/rpc.js).
//
// A reading is one system.multicall: getVersion, getGlobalStat,
// getGlobalOption (the speed limit), tellActive, tellWaiting and tellStopped
// (the results of the session, 1000 by default: --max-download-result), with
// only the keys used below. It becomes
//   { version, downloadSpeed, uploadSpeed (bytes/s), downloadLimit (bytes/s,
//     0 = none), downloads: [...] }
// and every download has the same shape (src/model.js uses it):
//   { gid, name, status, total, completed (bytes), downloadSpeed, dir,
//     errorCode, errorMessage, seeding, metadata }.
// -----------------------------------------------------------------------------

import { Aria2Error, Aria2Rpc, ERROR_KINDS } from './rpc.js';

export { ERROR_KINDS };

const KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'downloadSpeed',
  'uploadSpeed',
  'errorCode',
  'errorMessage',
  'dir',
  'files',
  'bittorrent',
  'followedBy',
];

// tellWaiting and tellStopped page through the lists: one page is enough
// for a home server (aria2 keeps 1000 results by default). tellStopped reads
// from the end (offset -1): the newest results first, whatever
// --max-download-result is.
export const MAX_LISTED = 1000;

const LIMIT_OPTION = 'max-overall-download-limit';

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

/** The last part of a path. */
const baseName = (path) => {
  const clean = String(path).replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
};

/** The last part of a URL, without its query, decoded. */
function uriName(uri) {
  const name = baseName(String(uri).split(/[?#]/)[0]);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The name aria2's own interfaces show: the torrent name, else the first
 * file, else the last part of its first URI.
 */
export function downloadName(raw) {
  const torrentName = raw.bittorrent?.info?.name;
  if (typeof torrentName === 'string' && torrentName) {
    return torrentName;
  }
  const [file] = Array.isArray(raw.files) ? raw.files : [];
  if (file?.path) {
    return baseName(file.path);
  }
  const uri = file?.uris?.[0]?.uri;
  if (uri) {
    if (uri.startsWith('magnet:')) {
      const dn = new URLSearchParams(uri.slice(uri.indexOf('?') + 1)).get('dn');
      if (dn) {
        return dn;
      }
    }
    return uriName(uri) || uri;
  }
  return raw.gid;
}

/** One download of a tell* answer in the shape of the model. */
export function parseDownload(raw) {
  const total = toNumber(raw.totalLength);
  const completed = toNumber(raw.completedLength);
  const isTorrent = Boolean(raw.bittorrent);
  return {
    gid: String(raw.gid),
    name: downloadName(raw),
    status: raw.status,
    total,
    completed,
    downloadSpeed: toNumber(raw.downloadSpeed),
    dir: typeof raw.dir === 'string' ? raw.dir : '',
    errorCode: raw.errorCode === undefined ? null : Number(raw.errorCode),
    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : '',
    // A complete torrent keeps sharing: aria2 lists it as active until
    // --seed-time or --seed-ratio is reached, and as paused or waiting after
    // a pauseAll. It stays a completed download, not one to do.
    seeding:
      isTorrent &&
      ['active', 'waiting', 'paused'].includes(raw.status) &&
      total > 0 &&
      completed >= total,
    // A magnet link first downloads its metadata, a .torrent or .metalink URL
    // its file: the real download follows (followedBy), under another gid.
    metadata: Array.isArray(raw.followedBy) && raw.followedBy.length > 0,
  };
}

export class Aria2Client {
  /**
   * @param {object} server normalized server (src/config.js)
   * @param {object} [options] { insecure, request }
   */
  constructor(server, { insecure = false, request } = {}) {
    this.rpc = new Aria2Rpc({ url: server.url, secret: server.secret, insecure, request });
  }

  async read() {
    const [version, stat, options, active, waiting, stopped] = await this.rpc.multicall([
      ['aria2.getVersion'],
      ['aria2.getGlobalStat'],
      ['aria2.getGlobalOption'],
      ['aria2.tellActive', KEYS],
      ['aria2.tellWaiting', 0, MAX_LISTED, KEYS],
      ['aria2.tellStopped', -1, MAX_LISTED, KEYS],
    ]);
    if (![active, waiting, stopped].every(Array.isArray)) {
      throw new Aria2Error(ERROR_KINDS.HTTP, 'tell*: unexpected answer');
    }
    return {
      version: typeof version?.version === 'string' ? version.version : null,
      downloadSpeed: toNumber(stat?.downloadSpeed),
      uploadSpeed: toNumber(stat?.uploadSpeed),
      downloadLimit: toNumber(options?.[LIMIT_OPTION]),
      downloads: [...active, ...waiting, ...stopped].map(parseDownload),
    };
  }

  pauseAll() {
    return this.rpc.call('aria2.pauseAll');
  }

  resumeAll() {
    return this.rpc.call('aria2.unpauseAll');
  }

  /** @param {number} bytesPerSecond 0 = no limit */
  setDownloadLimit(bytesPerSecond) {
    return this.rpc.call('aria2.changeGlobalOption', {
      [LIMIT_OPTION]: String(Math.round(bytesPerSecond)),
    });
  }

  /**
   * @param {string} uri
   * @param {string|null} dir
   * @returns {Promise<string>} the gid of the new download
   */
  async addUri(uri, dir) {
    const gid = await this.rpc.call('aria2.addUri', [uri], dir ? { dir } : {});
    return String(gid);
  }
}
