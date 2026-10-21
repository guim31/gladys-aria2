// -----------------------------------------------------------------------------
// What a reading means (src/aria2.js gives its shape).
//
// The four counters split the downloads of the session without overlap:
//   - active: receiving data (aria2 "active"), not a torrent already complete
//     and sharing;
//   - waiting: in the queue, waiting for a free slot or paused;
//   - completed: finished in this session (aria2 "complete", or a complete
//     torrent still sharing), not the metadata of a magnet link or the
//     .torrent file of a download that follows;
//   - in error: stopped by an error (dead link, disk full...).
// Removed downloads count nowhere. The completed and error lists are those
// aria2 keeps (--max-download-result, 1000), until it restarts or they are
// purged.
// -----------------------------------------------------------------------------

export const MAX_LISTED_DOWNLOADS = 3;
export const MAX_NAME_LENGTH = 40;

/** Cut a text to `max` characters, with an ellipsis. */
export const fit = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export const isActive = (d) => d.status === 'active' && !d.seeding;
export const isWaiting = (d) => (d.status === 'waiting' || d.status === 'paused') && !d.seeding;
export const isCompleted = (d) => (d.status === 'complete' && !d.metadata) || d.seeding;
export const isError = (d) => d.status === 'error';

/** Counters of a reading. */
export function countDownloads(downloads) {
  const counts = { active: 0, waiting: 0, paused: 0, completed: 0, errors: 0 };
  for (const d of downloads) {
    if (isActive(d)) {
      counts.active += 1;
    } else if (isWaiting(d)) {
      counts.waiting += 1;
      if (d.status === 'paused') {
        counts.paused += 1;
      }
    } else if (isCompleted(d)) {
      counts.completed += 1;
    } else if (isError(d)) {
      counts.errors += 1;
    }
  }
  return counts;
}

/** Downloads still to do: active or in the queue. */
export const pendingCount = (counts) => counts.active + counts.waiting;

/**
 * "Everything is paused": there is something left to download, and all of
 * it is paused (what aria2.pauseAll leaves). Nothing to download: not paused.
 */
export const allPaused = (counts) => counts.waiting > 0 && counts.paused === pendingCount(counts);

export const progressOf = (d) => (d.total > 0 ? Math.min(1, d.completed / d.total) : 0);

/**
 * The downloads in progress, most useful first: the ones receiving data
 * (fastest first), then the most advanced. Stable order for equal ones.
 */
export function downloadsInProgress(downloads) {
  return downloads
    .filter(isActive)
    .sort(
      (a, b) =>
        Number(b.downloadSpeed > 0) - Number(a.downloadSpeed > 0) ||
        progressOf(b) - progressOf(a) ||
        a.name.localeCompare(b.name) ||
        a.gid.localeCompare(b.gid),
    );
}

/**
 * Whole percent shown for a download: rounded down, so 99.6 % never reads
 * 100 % before the end.
 */
export const percentOf = (d) => Math.floor(progressOf(d) * 100);

/** "42 %" in French (a narrow no-break space before the sign), "42%" elsewhere. */
export const formatPercent = (value, language) =>
  language === 'fr' ? `${value}\u202f%` : `${value}%`;

/**
 * The text feature: the first three downloads in progress with their
 * percentage, "+N" for the others.
 * @param {Array} downloads
 * @param {string} language
 * @param {string} none text when nothing downloads (never empty: Gladys drops an empty text)
 */
export function downloadsText(downloads, language, none) {
  const list = downloadsInProgress(downloads);
  if (list.length === 0) {
    return none;
  }
  const parts = list
    .slice(0, MAX_LISTED_DOWNLOADS)
    .map((d) => `${fit(d.name, MAX_NAME_LENGTH)} ${formatPercent(percentOf(d), language)}`);
  if (list.length > MAX_LISTED_DOWNLOADS) {
    parts.push(`+${list.length - MAX_LISTED_DOWNLOADS}`);
  }
  return parts.join(' · ');
}

// Speeds published in kilobytes per second (1 kB = 1000 bytes, the unit
// Gladys names "kilobytes-per-second"), rounded: the decimals change at
// every reading and say nothing.
export const toKilobytesPerSecond = (bytesPerSecond) => Math.round(bytesPerSecond / 1000);

/** Size in gigabytes (10^9 bytes), two decimals, for the scene variables. */
export const toGigabytes = (bytes) => Math.round(bytes / 1e7) / 100;

/**
 * Speed for a widget tile or row: value and unit, in kB/s below 1 MB/s.
 * @returns {{ value: number, unit: string }}
 */
export function formatSpeed(bytesPerSecond, language) {
  const units =
    language === 'fr' ? { k: 'ko/s', m: 'Mo/s', g: 'Go/s' } : { k: 'kB/s', m: 'MB/s', g: 'GB/s' };
  if (bytesPerSecond >= 1e9) {
    return { value: Math.round(bytesPerSecond / 1e8) / 10, unit: units.g };
  }
  if (bytesPerSecond >= 1e6) {
    return { value: Math.round(bytesPerSecond / 1e5) / 10, unit: units.m };
  }
  return { value: Math.round(bytesPerSecond / 1000), unit: units.k };
}

/** A number written the way the language writes it (decimal comma in fr, de, es). */
export const formatNumber = (value, language) =>
  language === 'en' ? String(value) : String(value).replace('.', ',');

const stateOf = (d) =>
  isCompleted(d)
    ? 'complete'
    : isError(d)
      ? 'error'
      : isActive(d) || isWaiting(d)
        ? 'pending'
        : 'other';

/**
 * The scene events of a new reading, compared with the downloads seen before.
 *
 *   - completed: a download now complete that was not before (a small file
 *     can be added and finished between two readings: new and complete);
 *   - failed: the same, for a download stopped by an error;
 *   - queueEmpty: there was something to download, there is nothing left.
 * Nothing at the first reading of a server (baseline): only remember.
 *
 * A gid is announced complete once: a torrent checked again after a restart
 * of aria2 (--save-session) goes through "pending" before sharing again.
 *
 * @param {object} memory { known: Map<gid, state>, announced: Set<gid>, pending: number|null } (updated in place)
 * @param {Array} downloads the new reading
 * @param {boolean} baseline
 * @returns {{ completed: Array, failed: Array, queueEmpty: boolean }}
 */
export function diffDownloads(memory, downloads, baseline) {
  const completed = [];
  const failed = [];
  const seen = new Set();
  for (const d of downloads) {
    seen.add(d.gid);
    const state = stateOf(d);
    const before = memory.known.get(d.gid);
    if (!baseline && before !== state) {
      if (state === 'complete' && !memory.announced.has(d.gid)) {
        memory.announced.add(d.gid);
        completed.push(d);
      } else if (state === 'error') {
        failed.push(d);
      }
    }
    if (baseline && state === 'complete') {
      memory.announced.add(d.gid);
    }
    memory.known.set(d.gid, state);
  }
  for (const gid of memory.known.keys()) {
    if (!seen.has(gid)) {
      memory.known.delete(gid);
      memory.announced.delete(gid);
    }
  }
  const pending = pendingCount(countDownloads(downloads));
  const queueEmpty = !baseline && memory.pending > 0 && pending === 0;
  memory.pending = pending;
  return { completed, failed, queueEmpty };
}
