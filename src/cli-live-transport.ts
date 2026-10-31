import WebSocket from 'ws';
import type { RawData } from 'ws';
import { CliLiveError } from './cli-live.ts';
import type { CliLiveSession, CliLiveTransport, LiveClientMessage, LiveEvent, LiveRequest } from './cli-live.ts';

import { LIVE_MAX_FRAME_BYTES as MAX_FRAME, LIVE_MAX_BUFFERED_BYTES as MAX_BUFFERED, LIVE_START_TIMEOUT_MS } from './protocol.ts';
const MAX_EVENTS = 1024;

/** Credentials travel only in the upgrade header, never a URL or frame. */
export function createCliLiveTransport(controlUrl: string, operatorToken?: string): CliLiveTransport {
  const url = new URL(controlUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliLiveError('live control URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new CliLiveError('live control URL must not contain credentials, query or fragment');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/live`;
  return {
    open(request: LiveRequest, signal: AbortSignal): Promise<CliLiveSession> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new CliLiveError('live connection cancelled', 130)); return; }
        const socket = new WebSocket(url, { headers: operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}, maxPayload: MAX_FRAME, handshakeTimeout: LIVE_START_TIMEOUT_MS, perMessageDeflate: false });
        let opened = false;
        let closed = false;
        let ended = false;
        let queuedBytes = 0;
        let sessionId: string | undefined;
        const queue: { event: LiveEvent; size: number }[] = [];
        let notify: (() => void) | undefined;
        const wake = (): void => { notify?.(); notify = undefined; };
        const enqueue = (event: LiveEvent, size = 0): void => {
          if (ended) return;
          if (queue.length >= MAX_EVENTS || queuedBytes + size > MAX_BUFFERED) {
            queue.length = 0;
            queuedBytes = 0;
            event = { type: 'error', message: 'live response exceeded the receive buffer limit' };
            size = 0;
          }
          queue.push({ event, size });
          queuedBytes += size;
          if (event.type === 'error' || event.type === 'exit' || event.type === 'disconnect') ended = true;
          wake();
          if (event.type === 'error') socket.terminate();
        };
        const sendFrame = (frame: object): Promise<void> => new Promise((done, failed) => {
          const data = JSON.stringify({ v: 1, ...frame });
          if (Buffer.byteLength(data) > MAX_FRAME || socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED) { failed(new CliLiveError('live request exceeded the send buffer limit')); return; }
          if (socket.readyState !== WebSocket.OPEN) { failed(new CliLiveError('live connection is closed')); return; }
          socket.send(data, error => { if (error) failed(error); else done(); });
        });
        const send = async (message: LiveClientMessage): Promise<void> => {
          if (message.type === 'stdin') {
            // Bound individual frames even when a piped input stream yields a large chunk.
            for (let offset = 0; offset < message.data.byteLength; offset += 48 * 1024) await sendFrame({ type: 'live.stdin', data: Buffer.from(message.data.subarray(offset, offset + 48 * 1024)).toString('base64') });
          } else if (message.type === 'resize') await sendFrame({ type: 'live.resize', columns: message.columns, rows: message.rows });
          else await sendFrame({ type: message.type === 'cancel' ? 'live.cancel' : 'live.stdin-end' });
        };
        const session: CliLiveSession = {
          events: {
            async *[Symbol.asyncIterator]() {
              while (true) {
                const item = queue.shift();
                if (item) { queuedBytes -= item.size; yield item.event; }
                else if (ended || closed) return;
                else await new Promise<void>(ready => { notify = ready; });
              }
            }
          },
          send,
          close() {
            signal.removeEventListener('abort', abort);
            enqueue({ type: 'disconnect', message: 'live session closed' });
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          }
        };
        const abort = (): void => {
          if (!opened) reject(new CliLiveError('live connection cancelled', 130));
          enqueue({ type: 'disconnect', message: 'live connection cancelled' });
          socket.terminate();
        };
        const onError = (error: Error): void => {
          if (!opened) reject(new CliLiveError(`live connection failed: ${error.message}`));
          enqueue({ type: 'error', message: `live connection failed: ${error.message}` });
        };
        const onMessage = (data: RawData, binary: boolean): void => {
          if (ended) return;
          try {
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
            if (binary || bytes.byteLength > MAX_FRAME) throw new Error('invalid or oversized live frame');
            const frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
            if (!frame || typeof frame !== 'object' || frame.v !== 1 || typeof frame.type !== 'string') throw new Error('invalid live frame envelope');
            if (frame.type !== 'live.error' && (typeof frame.sessionId !== 'string' || !frame.sessionId)) throw new Error('invalid live session identifier');
            if (frame.sessionId !== undefined && (typeof frame.sessionId !== 'string' || !frame.sessionId || (sessionId !== undefined && sessionId !== frame.sessionId))) throw new Error('invalid live session identifier');
            if (typeof frame.sessionId === 'string') sessionId = frame.sessionId;
            switch (frame.type) {
              case 'live.started':
                if (typeof frame.node !== 'string' || !frame.node) throw new Error('invalid live started frame');
                if (opened) throw new Error('duplicate live started frame');
                opened = true;
                resolve(session);
                break;
              case 'live.output': {
                if (!opened) throw new Error('live output arrived before startup');
                if ((frame.stream !== 'stdout' && frame.stream !== 'stderr') || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('invalid live output frame');
                const decoded = Buffer.from(frame.data, 'base64');
                if (decoded.toString('base64') !== frame.data) throw new Error('invalid live output encoding');
                enqueue({ type: frame.stream, data: decoded }, bytes.byteLength);
                break;
              }
              case 'live.result':
                if (!opened) throw new Error('live result arrived before startup');
                if (!Object.hasOwn(frame, 'value')) throw new Error('invalid live result frame');
                enqueue({ type: 'result', value: frame.value }, bytes.byteLength);
                break;
              case 'live.exit':
                if (!opened) throw new Error('live exit arrived before startup');
                if (!Number.isInteger(frame.code) || Number(frame.code) < 0 || Number(frame.code) > 255) throw new Error('invalid live exit frame');
                enqueue({ type: 'exit', code: Number(frame.code) });
                break;
              case 'live.error':
                if (typeof frame.message !== 'string' || !frame.message) throw new Error('invalid live error frame');
                if (!opened) { ended = true; reject(new CliLiveError(frame.message)); socket.terminate(); }
                else enqueue({ type: 'error', message: frame.message });
                break;
              default: throw new Error('unknown live frame type');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'invalid live frame';
            if (!opened) { ended = true; reject(new CliLiveError(message)); socket.terminate(); }
            else enqueue({ type: 'error', message });
          }
        };
        const onClose = (): void => {
          closed = true;
          signal.removeEventListener('abort', abort);
          socket.off('message', onMessage).off('error', onError);
          if (!opened) reject(new CliLiveError('live connection closed before opening'));
          enqueue({ type: 'disconnect', message: 'live connection disconnected before exit' });
          wake();
        };
        socket.on('message', onMessage).on('error', onError).once('close', onClose);
        signal.addEventListener('abort', abort, { once: true });
        socket.once('open', () => {
          void sendFrame({ type: 'live.open', request }).catch(onError);
        });
      });
    }
  };
}
