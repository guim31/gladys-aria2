// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `downloads`.
//
// The use case: from the wall tablet, see what downloads and how fast, and
// pause everything or slow it down when a film starts.
//
// Budget (8 components, 6 tiles, 1 status, 4 buttons): three tiles (download
// speed, upload speed, active downloads), one status list (the downloads in
// progress with their percentage and speed, then the waiting, completed and
// failed counts) and three direct buttons: Pause all, Resume all, Slow down
// (a toggle: the check mark says it is on). The figures are sent as values,
// not bound to device features, so the widget works before the device is
// added.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS } from './rpc.js';
import { serverName } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import {
  countDownloads,
  downloadsInProgress,
  fit,
  formatNumber,
  formatPercent,
  formatSpeed,
  percentOf,
} from './model.js';
import { pick } from './texts.js';

// Action keys of the buttons: permanent once published (unique, the core
// drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  PAUSE_ALL: 'pause_all',
  RESUME_ALL: 'resume_all',
  SLOW_DOWN: 'slow_down',
});

// Download rows of the status list (10 rows at most, with the three counters).
export const MAX_DOWNLOAD_ROWS = 5;

const ACTIVE_ICON = 'check-circle';

export const TEXT = {
  pick: {
    en: 'Enter the RPC address of aria2 in the configuration of the integration.',
    fr: "Saisissez l'adresse RPC d'aria2 dans la configuration de l'intégration.",
    de: 'Gib die RPC-Adresse von aria2 in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección RPC de aria2 en la configuración de la integración.',
  },
  noAnswer: {
    en: 'aria2 does not answer: see the Configuration screen of the integration.',
    fr: "aria2 ne répond pas : voir l'écran Configuration de l'intégration.",
    de: 'aria2 antwortet nicht: Sieh dir die Konfiguration der Integration an.',
    es: 'aria2 no responde: consulte la pantalla de configuración de la integración.',
  },
  download: { en: 'Download', fr: 'Réception', de: 'Download', es: 'Descarga' },
  upload: { en: 'Upload', fr: 'Envoi', de: 'Upload', es: 'Subida' },
  active: { en: 'Active', fr: 'Actifs', de: 'Aktiv', es: 'Activas' },
  waiting: {
    en: 'Waiting downloads',
    fr: 'Téléchargements en attente',
    de: 'Wartende Downloads',
    es: 'Descargas en espera',
  },
  completed: {
    en: 'Completed downloads',
    fr: 'Téléchargements terminés',
    de: 'Fertige Downloads',
    es: 'Descargas completadas',
  },
  errors: {
    en: 'Failed downloads',
    fr: 'Téléchargements en erreur',
    de: 'Fehlgeschlagene Downloads',
    es: 'Descargas con error',
  },
  noDownload: {
    en: 'No download in progress',
    fr: 'Aucun téléchargement en cours',
    de: 'Kein laufender Download',
    es: 'Ninguna descarga en curso',
  },
  unreachable: { en: 'Unreachable', fr: 'Injoignable', de: 'Nicht erreichbar', es: 'Inaccesible' },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  connecting: { en: 'Waiting…', fr: 'En attente…', de: 'Warte…', es: 'Esperando…' },
  none: { en: 'None', fr: 'Aucun', de: 'Keiner', es: 'Ninguno' },
  pauseAll: { en: 'Pause all', fr: 'Tout en pause', de: 'Alle pausieren', es: 'Pausar todo' },
  resumeAll: { en: 'Resume all', fr: 'Tout reprendre', de: 'Alle fortsetzen', es: 'Reanudar todo' },
  slowDown: { en: 'Slow down', fr: 'Ralentir', de: 'Drosseln', es: 'Frenar' },
};

// Toasts after a tap (≤ 200 characters).
export const DONE_TEXT = {
  en: {
    paused: 'Every download is paused.',
    resumed: 'Every download is resumed.',
    slowOn: (limit) => `Downloads limited to ${limit} kB/s.`,
    slowOff: 'Download speed limit removed.',
  },
  fr: {
    paused: 'Tous les téléchargements sont en pause.',
    resumed: 'Tous les téléchargements reprennent.',
    slowOn: (limit) => `Téléchargements limités à ${limit} ko/s.`,
    slowOff: 'Limite de débit descendant retirée.',
  },
  de: {
    paused: 'Alle Downloads sind pausiert.',
    resumed: 'Alle Downloads laufen weiter.',
    slowOn: (limit) => `Downloads auf ${limit} kB/s begrenzt.`,
    slowOff: 'Download-Limit entfernt.',
  },
  es: {
    paused: 'Todas las descargas están en pausa.',
    resumed: 'Todas las descargas se reanudan.',
    slowOn: (limit) => `Descargas limitadas a ${limit} kB/s.`,
    slowOff: 'Límite de descarga eliminado.',
  },
};

const t = (text, language) => pick(text, language);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** A speed tile: the unit follows the value (kB/s, MB/s, GB/s). */
function speedTile(bytesPerSecond, label, icon, language) {
  const { value, unit } = formatSpeed(bytesPerSecond, language);
  return { type: 'value', value, unit, label: t(label, language), icon };
}

/** The status row of a server that does not answer (yet). */
function errorRow(record, language) {
  const label = fit(serverName(record.server), 40);
  if (record.error) {
    const unreachable = record.error.kind === ERROR_KINDS.UNREACHABLE;
    return {
      label,
      icon: 'alert-triangle',
      value: t(unreachable ? TEXT.unreachable : TEXT.error, language),
      color: WIDGET_COLORS.DANGER,
    };
  }
  return {
    label,
    icon: 'clock',
    value: t(TEXT.connecting, language),
    color: WIDGET_COLORS.NEUTRAL,
  };
}

/** The status row of one download: its name, its percentage and speed. */
function downloadRow(d, language) {
  const percent = formatPercent(percentOf(d), language);
  let value = percent;
  if (d.downloadSpeed > 0) {
    const speed = formatSpeed(d.downloadSpeed, language);
    value = `${percent} · ${formatNumber(speed.value, language)} ${speed.unit}`;
  }
  return {
    label: fit(d.name, 40),
    icon: 'download',
    value,
    color: d.downloadSpeed > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
  };
}

export function buttons(record, language) {
  const slowed = Boolean(record.reading && record.reading.downloadLimit > 0);
  return [
    {
      type: 'button',
      label: t(TEXT.pauseAll, language),
      icon: 'pause',
      style: 'secondary',
      action: { key: ACTIONS.PAUSE_ALL },
    },
    {
      type: 'button',
      label: t(TEXT.resumeAll, language),
      icon: 'play',
      style: 'secondary',
      action: { key: ACTIONS.RESUME_ALL },
    },
    {
      type: 'button',
      label: t(TEXT.slowDown, language),
      // On: the check mark says so (never the style: `primary` is invisible
      // in dark mode). A tap switches to the other state.
      icon: slowed ? ACTIVE_ICON : 'chevrons-down',
      style: 'secondary',
      action: { key: ACTIONS.SLOW_DOWN, params: { enabled: !slowed } },
    },
  ];
}

async function get(hub, { language = 'en' }) {
  const record = hub.record;
  if (!record) {
    return message(TEXT.pick, language);
  }
  const components = [];
  const items = [];
  const answering = record.reading && !record.error;
  if (!answering) {
    components.push({ type: 'text', variant: 'body', text: t(TEXT.noAnswer, language) });
    items.push(errorRow(record, language));
  } else {
    const { downloads } = record.reading;
    const counts = countDownloads(downloads);
    components.push(
      speedTile(record.reading.downloadSpeed, TEXT.download, 'arrow-down', language),
      speedTile(record.reading.uploadSpeed, TEXT.upload, 'arrow-up', language),
      {
        type: 'value',
        value: counts.active,
        label: t(TEXT.active, language),
        icon: 'download',
        color: counts.active > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
      },
    );
    const list = downloadsInProgress(downloads);
    if (list.length === 0) {
      items.push({
        label: t(TEXT.noDownload, language),
        icon: 'check',
        value: t(TEXT.none, language),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    items.push(...list.slice(0, MAX_DOWNLOAD_ROWS).map((d) => downloadRow(d, language)));
    items.push(
      {
        label: t(TEXT.waiting, language),
        icon: 'pause-circle',
        value: counts.waiting,
        color: counts.waiting > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
      },
      {
        label: t(TEXT.completed, language),
        icon: 'check-circle',
        value: counts.completed,
        color: WIDGET_COLORS.SUCCESS,
      },
      {
        label: t(TEXT.errors, language),
        icon: 'x-circle',
        value: counts.errors,
        color: counts.errors > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
      },
    );
  }
  components.push({ type: 'status', items: items.slice(0, 10) });
  components.push(...buttons(record, language));
  return { ttl_seconds: 30, components };
}

async function action(hub, { actionKey, params = {} }) {
  const done = (render) =>
    Object.fromEntries(Object.entries(DONE_TEXT).map(([lang, text]) => [lang, render(text)]));

  if (actionKey === ACTIONS.PAUSE_ALL) {
    await hub.pauseAll();
    return { message: done((text) => text.paused) };
  }
  if (actionKey === ACTIONS.RESUME_ALL) {
    await hub.resumeAll();
    return { message: done((text) => text.resumed) };
  }
  if (actionKey === ACTIONS.SLOW_DOWN) {
    const enabled = params.enabled !== false;
    await hub.slowDown(enabled);
    const limit = hub.config.slowLimitKbps;
    return { message: done((text) => (enabled ? text.slowOn(limit) : text.slowOff)) };
  }
  throw new Error(`Unknown action ${actionKey}`);
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
