// -----------------------------------------------------------------------------
// The aria2 JSON-RPC client, over HTTP POST: the secret goes first in every
// call (`token:<secret>`), several calls share one request through
// `system.multicall`. Every failure becomes an Aria2Error of a known kind,
// with an English message for the logs that never contains the secret.
// https://aria2.github.io/manual/en/html/aria2c.html#rpc-interface
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // wrong or missing secret
  NOT_FOUND: 'not_found', // something answers, not the aria2 RPC interface
  REJECTED: 'rejected', // aria2 refused the command (bad URI, unknown option...)
  HTTP: 'http', // any other answer
});

export class Aria2Error extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains the secret)
   */
  constructor(kind, message) {
    super(message);
    this.name = 'Aria2Error';
    this.kind = kind;
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A failed request (no HTTP answer) as an Aria2Error. */
export function networkError(err) {
  if (TLS_CODES.has(err.code)) {
    return new Aria2Error(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
  }
  return new Aria2Error(ERROR_KINDS.UNREACHABLE, err.code ? `${err.code}` : err.message);
}

/** A JSON-RPC error object of aria2 as an Aria2Error. */
export function faultError(fault, method) {
  const message = typeof fault?.message === 'string' ? fault.message.slice(0, 200) : 'error';
  // aria2 answers {"code":1,"message":"Unauthorized"} to a wrong or missing secret.
  if (message === 'Unauthorized') {
    return new Aria2Error(ERROR_KINDS.AUTH, `${method}: secret refused`);
  }
  return new Aria2Error(ERROR_KINDS.REJECTED, `${method}: ${message}`);
}

export class Aria2Rpc {
  /**
   * @param {object} options
   * @param {string} options.url the JSON-RPC URL (src/config.js parseRpcUrl)
   * @param {string} options.secret --rpc-secret, empty when none
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {Function} [options.request] HTTP seam (src/http.js)
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, secret, insecure = false, request = httpRequest, timeoutMs = 15_000 }) {
    this.url = url;
    this.secret = secret;
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  /** The parameters of a call, the secret first when there is one. */
  params(params = []) {
    return this.secret ? [`token:${this.secret}`, ...params] : params;
  }

  async post(method, params) {
    const id = String(this.nextId++);
    let response;
    try {
      response = await this.request(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw networkError(err);
    }
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0') {
      // A web page, a proxy error: not the RPC interface of aria2.
      const kind = response.status === 200 ? ERROR_KINDS.HTTP : ERROR_KINDS.NOT_FOUND;
      throw new Aria2Error(kind, `${method}: HTTP ${response.status}, not a JSON-RPC answer`);
    }
    if (body.error) {
      throw faultError(body.error, method);
    }
    return body.result;
  }

  /** One call. */
  call(method, ...params) {
    return this.post(method, this.params(params));
  }

  /**
   * Several calls in one request. A call refused by aria2 rejects the whole
   * batch with its error: the reading needs them all.
   * @param {Array<[string, ...unknown[]]>} calls
   * @returns {Promise<unknown[]>} the results, in order
   */
  async multicall(calls) {
    const results = await this.post('system.multicall', [
      calls.map(([methodName, ...params]) => ({ methodName, params: this.params(params) })),
    ]);
    if (!Array.isArray(results) || results.length !== calls.length) {
      throw new Aria2Error(ERROR_KINDS.HTTP, 'system.multicall: unexpected answer');
    }
    return results.map((result, index) => {
      if (Array.isArray(result)) {
        return result[0];
      }
      throw faultError(result, calls[index][0]);
    });
  }
}
