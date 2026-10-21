// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, scene action
// errors, the text feature when nothing downloads. Four languages, the four
// of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './rpc.js';

export const LANGUAGE_FALLBACK = 'en';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// The text feature "Current downloads" when nothing downloads (Gladys
// ignores an empty text).
export const NO_DOWNLOAD = {
  en: 'No download in progress',
  fr: 'Aucun téléchargement en cours',
  de: 'Kein laufender Download',
  es: 'Ninguna descarga en curso',
};

export const CONNECTION_TEXT = {
  noServer: {
    en: 'Enter the RPC address of aria2 in the configuration.',
    fr: "Saisissez l'adresse RPC d'aria2 dans la configuration.",
    de: 'Gib die RPC-Adresse von aria2 in der Konfiguration ein.',
    es: 'Introduzca la dirección RPC de aria2 en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. 192.168.1.10:6800',
    fr: 'Adresse incomprise, ex. 192.168.1.10:6800',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.10:6800',
    es: 'Dirección no válida, p. ej. 192.168.1.10:6800',
  },
};

// One short explanation per error kind (src/rpc.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'aria2 does not answer: is it started with --enable-rpc?',
    fr: 'aria2 ne répond pas : est-il lancé avec --enable-rpc ?',
    de: 'aria2 antwortet nicht: Läuft es mit --enable-rpc?',
    es: 'aria2 no responde: ¿se ha iniciado con --enable-rpc?',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'secret refused: check the RPC secret (--rpc-secret)',
    fr: 'secret refusé : vérifiez le secret RPC (--rpc-secret)',
    de: 'Secret abgelehnt: Prüfe das RPC-Secret (--rpc-secret)',
    es: 'secreto rechazado: compruebe el secreto RPC (--rpc-secret)',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'no aria2 RPC at this address: check the port and the path',
    fr: 'pas de RPC aria2 à cette adresse : vérifiez le port et le chemin',
    de: 'kein aria2-RPC unter dieser Adresse: Prüfe Port und Pfad',
    es: 'no hay RPC de aria2 en esta dirección: compruebe el puerto y la ruta',
  },
  [ERROR_KINDS.REJECTED]: {
    en: 'command refused by aria2, see the logs',
    fr: 'commande refusée par aria2, voir les logs',
    de: 'Befehl von aria2 abgelehnt, sieh in den Protokollen nach',
    es: 'orden rechazada por aria2, consulte los registros',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    downloads: (active, waiting) => `${active} active, ${waiting} waiting`,
    notifications: 'instant notifications on',
    polling: 'no instant notifications (WebSocket refused): read at the refresh interval',
  },
  fr: {
    ok: 'OK',
    downloads: (active, waiting) => `${active} actif(s), ${waiting} en attente`,
    notifications: 'notifications instantanées actives',
    polling: "pas de notifications instantanées (WebSocket refusé) : lecture à l'intervalle choisi",
  },
  de: {
    ok: 'OK',
    downloads: (active, waiting) => `${active} aktiv, ${waiting} wartend`,
    notifications: 'Sofortbenachrichtigungen an',
    polling: 'keine Sofortbenachrichtigungen (WebSocket abgelehnt): Lesen im gewählten Intervall',
  },
  es: {
    ok: 'OK',
    downloads: (active, waiting) => `${active} activa(s), ${waiting} en espera`,
    notifications: 'notificaciones instantáneas activas',
    polling: 'sin notificaciones instantáneas (WebSocket rechazado): lectura al intervalo elegido',
  },
};

// Errors of the scene actions and widget buttons (shown in Gladys).
export const ACTION_TEXT = {
  noServer: {
    en: 'No aria2 server is configured.',
    fr: "Aucun serveur aria2 n'est configuré.",
    de: 'Kein aria2-Server ist konfiguriert.',
    es: 'No hay ningún servidor aria2 configurado.',
  },
  badUri: {
    en: 'This is not a link aria2 can download (http, https, ftp, sftp or magnet).',
    fr: "Ce n'est pas un lien qu'aria2 sait télécharger (http, https, ftp, sftp ou magnet).",
    de: 'Das ist kein Link, den aria2 laden kann (http, https, ftp, sftp oder magnet).',
    es: 'No es un enlace que aria2 pueda descargar (http, https, ftp, sftp o magnet).',
  },
  badDir: {
    en: 'The folder must be an absolute path on the aria2 server, without "..".',
    fr: 'Le dossier doit être un chemin absolu sur le serveur aria2, sans « .. ».',
    de: 'Der Ordner muss ein absoluter Pfad auf dem aria2-Server sein, ohne „..“.',
    es: 'La carpeta debe ser una ruta absoluta en el servidor aria2, sin «..».',
  },
  badLimit: {
    en: 'The limit is a whole number of kB/s, 0 for none.',
    fr: 'La limite est un nombre entier de ko/s, 0 pour aucune.',
    de: 'Das Limit ist eine ganze Zahl in kB/s, 0 für keins.',
    es: 'El límite es un número entero de kB/s, 0 para ninguno.',
  },
};

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
