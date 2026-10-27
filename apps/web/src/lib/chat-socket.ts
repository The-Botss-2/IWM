'use client';

import { io, type Socket } from 'socket.io-client';

import { env } from './env';
import { setChatConnectionState } from './realtime-status';
import { getSupportSession } from './support-session';
import { toastError } from './toast';

let socket: Socket | null = null;

/** Capabilities the API advertised in its last `connected` event. */
let serverFeatures: ReadonlySet<string> = new Set();

/**
 * True when the connected API advertised `feature` (see the gateway's
 * `connected` emit). False before the first connect and against an older API,
 * so callers keep their previous behaviour until the server opts in.
 */
export function chatServerHasFeature(feature: string): boolean {
  return serverFeatures.has(feature);
}

/** Delay before retrying after the server refused the socket because it could
 *  not verify the session (a 503 during a deploy restart or a DB blip). */
const UNAVAILABLE_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Reconnect the chat socket now if it is down. Used after the machine wakes:
 * otherwise the desktop app can sit in the tray without live notifications
 * until socket.io's backoff gets round to retrying. No-op before the socket
 * exists or while it is connected.
 */
export function reconnectChatSocket(): void {
  if (getSupportSession()) return;
  if (socket && !socket.connected) socket.connect();
}

export function getChatSocket(): Socket {
  if (socket) return socket;
  // A read only support session never connects: the socket would sign in
  // with the cookie as the platform operator's own account (their chat,
  // presence and calls) under the support banner. Callers get a socket that
  // simply stays disconnected.
  const support = getSupportSession() !== null;
  const s = io(`${env.apiUrl}/chat`, {
    withCredentials: true,
    transports: ['websocket', 'polling'],
    autoConnect: !support,
  });
  if (support) {
    socket = s;
    return s;
  }

  // socket.io never auto-reconnects after a SERVER-initiated disconnect. That
  // is right for `auth_error` (no valid session), but wrong for
  // `server_unavailable`, where the cookie is fine and the API just could not
  // look it up. Without this the chat socket stayed dead after every deploy
  // until a full page reload.
  let unavailable = false;
  let attempt = 0;
  // One "Couldn't connect" toast per outage; the banner covers the rest.
  let offlineReported = false;
  s.on('server_unavailable', () => {
    unavailable = true;
  });
  s.on('connect', () => {
    unavailable = false;
    attempt = 0;
    offlineReported = false;
    setChatConnectionState('live');
  });
  s.on('connected', (payload: { features?: unknown }) => {
    const list = Array.isArray(payload?.features) ? payload.features : [];
    serverFeatures = new Set(list.filter((f): f is string => typeof f === 'string'));
  });
  // `active` is true while socket.io will retry on its own (transport drop,
  // network change). A refused handshake leaves it false: nothing retries.
  s.on('connect_error', (err) => {
    if (s.active) {
      setChatConnectionState('reconnecting');
      return;
    }
    setChatConnectionState('offline');
    if (!offlineReported) {
      offlineReported = true;
      toastError(err, "Couldn't connect to chat");
    }
  });
  // No global 'exception' listener on purpose: Nest emits it for every failed
  // handler without saying which event failed, so it can't tell a real error
  // from a benign one (typing after removal from a room, a late ICE candidate
  // after hang-up) or from one the emit site already reports through its ack,
  // timeout or REST fallback. Failures are reported at those emit sites.
  s.on('disconnect', (reason) => {
    const willRetry = s.active || (reason === 'io server disconnect' && unavailable);
    // A deliberate client disconnect is not an outage.
    if (reason === 'io client disconnect') setChatConnectionState('connecting');
    else setChatConnectionState(willRetry ? 'reconnecting' : 'offline');
    if (reason !== 'io server disconnect' || !unavailable) return;
    const delay = UNAVAILABLE_RETRY_MS[Math.min(attempt, UNAVAILABLE_RETRY_MS.length - 1)];
    attempt += 1;
    setTimeout(() => {
      if (socket === s && !s.connected) s.connect();
    }, delay);
  });

  socket = s;
  return s;
}
