import crypto from 'node:crypto';
import type https from 'node:https';

/**
 * TLS options for the single control listener: TLS 1.3, a client certificate from the pinned CA on every connection
 * (failures end the handshake before any HTTP is parsed) and no session resumption, so each connection that carries
 * requests has presented its certificate in a full handshake.
 */
export function serverTlsOptions(options: {
  cert: string;
  key: string;
  ca: string;
}): https.ServerOptions {
  return {
    cert: options.cert,
    key: options.key,
    ca: options.ca,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    requestCert: true,
    rejectUnauthorized: true,
    // OpenSSL can fall back to stateful TLS 1.3 tickets, so the ticket option alone is not enough: the empty session
    // id context and zero timeout make the cache refuse everything, and the gate still closes any reused session.
    secureOptions: crypto.constants.SSL_OP_NO_TICKET,
    sessionTimeout: 0,
    sessionIdContext: crypto.randomBytes(16).toString('hex'),
    handshakeTimeout: 10_000,
  } as https.ServerOptions;
}
