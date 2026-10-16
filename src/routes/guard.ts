/**
 * Shared guards for this plugin's HTTP routes.
 *
 * Extracted because two routes now need identical treatment, and a guard that is
 * copy-pasted stops being a guard the first time one copy is edited.
 *
 * WHY THE GUARD EXISTS AT ALL
 * ---------------------------
 * On a bare `dsh web` profile a third-party named route is unauthenticated: the
 * carrier owns no TLS, authentication, or Origin policy, and the Host/Origin
 * checks that do exist belong to `client/connection` and cover only the routes it
 * registers itself. The Desktop carrier adds its own gate (an
 * `x-dsh-desktop-renderer` token; unauthenticated requests get 403), but a route
 * that is safe only on one carrier is not safe.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestHandler } from '@deepseek-ai/cordis';

/** This plugin only ever answers reads. */
export const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean} whether the peer is this machine
 */
export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    // Node reports an absent family as an empty string for unix sockets.
    address === ''
  );
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(payload);
}

/**
 * Run the shared pre-checks, answering the request when one fails.
 *
 * `methods` exists because the default set is the read-only one: the coverage route
 * answers GET and HEAD and nothing else, and giving it POST would widen it by accident.
 * A route that legitimately mutates passes its own set, so the method policy is stated
 * at the route rather than inferred from what the guard happens to allow.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param methods the methods this route accepts
 * @returns `true` when the caller may continue handling the request
 */
export function passGuard(
  req: IncomingMessage,
  res: ServerResponse,
  methods: ReadonlySet<string> = ALLOWED_METHODS,
): boolean {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback only' });
    return false;
  }
  if (!methods.has(req.method ?? '')) {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: [...methods].join(', ') });
    return false;
  }
  return true;
}

/**
 * Answer a HEAD request with headers only, or report that the caller should
 * continue and send the body.
 *
 * @returns `true` when the request was fully answered
 */
export function answerHead(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'HEAD') return false;
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end();
  return true;
}

/**
 * Wrap a handler so no failure escapes as an unhandled rejection on the carrier.
 *
 * `Promise.resolve` around the call is not decoration: `RequestHandler` may return
 * `void`, and calling `.catch` on `void` is a runtime `TypeError`. The shape the
 * carrier actually uses is "sync throw or async rejection", and only the resolved
 * form covers both.
 */
export function guardHandler(handler: RequestHandler): RequestHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    Promise.resolve(handler(req, res)).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        ok: false,
        code: 'internal-error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

/**
 * Extra guard for routes that *change* something.
 *
 * The loopback check alone is not enough for a mutation: any page the operator
 * visits can issue a request to `127.0.0.1`, and a cross-origin `POST` needs no
 * preflight when it uses a simple content type. `Origin` is the discriminator —
 * a malicious page always sends its own origin, and it will not match this host.
 *
 * A request with NO `Origin` is allowed through, and that is deliberate rather
 * than lazy: a same-origin `fetch` from the desktop shell, and any local tool
 * (including this repository's own tests), legitimately send none. The remaining
 * gates — loopback peer, and the Desktop carrier's renderer token — still apply,
 * so an absent header is not by itself a way in.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} `true` when the caller may proceed
 */
export function passWriteGuard(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;

  const host = req.headers.host;
  if (typeof host === 'string' && host !== '') {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      /* malformed origin falls through to the refusal below */
    }
  }

  sendJson(res, 403, {
    ok: false,
    code: 'cross-origin-write',
    message: 'this endpoint changes state and refuses cross-origin requests',
  });
  return false;
}

/**
 * Read a JSON body with a hard byte cap.
 *
 * Bounded because the cap is the only thing standing between a malformed client
 * and unbounded host memory — and this plugin's bodies are at most a few fields.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = 8 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    req.on('error', reject);
  });
}
