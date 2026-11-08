import { Agent, fetch as undiciFetch } from 'undici';
import { clientTlsOptions } from './pki.ts';
import type { Credential } from './pki.ts';
import { CLIENT_VERSION_HEADER } from './protocol.ts';
import { packageVersion } from './images/image.ts';

type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A client pinned to the credential's CA that presents its certificate. `connectUrl` only changes where the TCP
 * connection goes; the server name is still verified against the credential's public host. Redirects are refused.
 */
export function createTransport(credential: Credential, connectUrl?: string) {
  const dispatcher = new Agent({ connect: clientTlsOptions(credential) as never });
  const base = new URL(connectUrl ?? credential.url).origin;
  const http: HttpClient = (url, init) => {
    // Every request declares the calling process's version, so the control can refuse one that is newer than it is
    // before running the handler; the CLI's own skew checks flow from the stamped responses this header rides on.
    // Only toward the control: this client is also handed to agent health checks that dial application containers, which
    // must not learn the Tug version.
    const headers = new Headers(init?.headers);
    if (!headers.has(CLIENT_VERSION_HEADER) && new URL(url).origin === base)
      headers.set(CLIENT_VERSION_HEADER, packageVersion());
    let request = { ...init, headers } as RequestInit;
    // The runtime's FormData is not the undici package's FormData, which would stringify it. Serialize it with the
    // runtime's own Response and stream the result.
    if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
      const encoded = new Response(init.body);
      headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');
      request = { ...init, headers, body: encoded.body, duplex: 'half' } as RequestInit;
    }
    return undiciFetch(url, {
      ...(request as object),
      redirect: 'error',
      dispatcher,
    } as never) as unknown as Promise<Response>;
  };
  return { http, base, dispatcher, close: () => dispatcher.close() };
}
