/**
 * rpc.mjs — JSON-RPC 2.0 dispatch for the app-server connection.
 *
 * Split from the transport and from the handlers so the routing rules can be
 * tested without a socket or an engine: what counts as a request vs a
 * notification, what an unknown method returns, and how a handler's failure is
 * reported rather than propagated.
 */

/** JSON-RPC reserved codes, plus the one we use for "not implemented here". */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export const isRequest = (m) => Boolean(m && typeof m === "object" && m.method && m.id !== undefined && m.id !== null);
export const isNotification = (m) => Boolean(m && typeof m === "object" && m.method && (m.id === undefined || m.id === null));
export const isResponse = (m) => Boolean(m && typeof m === "object" && !m.method && m.id !== undefined);

export const okResponse = (id, result) => ({ id, result });
export const errResponse = (id, code, message, data) => ({
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * Route messages to handlers.
 *
 * `handlers` maps method name → async (params, ctx) => result. A method absent
 * from the map goes to `fallback` when one is supplied — that is the seam the
 * hybrid server uses to forward platform methods it does not implement — and
 * otherwise returns METHOD_NOT_FOUND.
 *
 * Handlers never see transport concerns: they return a value or throw. A thrown
 * error becomes an error response, so one bad request cannot end the session.
 */
export function createDispatcher({ handlers = {}, fallback = null, onError = () => {} } = {}) {
  return async function dispatch(message, ctx = {}) {
    if (!isRequest(message) && !isNotification(message)) {
      // A response to something WE asked the client (e.g. an approval): the
      // caller correlates those, not us.
      return null;
    }
    const { method, params, id } = message;
    const handler = handlers[method];
    try {
      if (!handler) {
        if (fallback) {
          const result = await fallback(method, params, ctx, message);
          return isNotification(message) ? null : okResponse(id, result);
        }
        if (isNotification(message)) return null; // notifications are fire-and-forget
        return errResponse(id, RPC.METHOD_NOT_FOUND, `unknown method: ${method}`);
      }
      const result = await handler(params ?? {}, ctx);
      if (isNotification(message)) return null;
      return okResponse(id, result === undefined ? null : result);
    } catch (error) {
      onError(error, method);
      if (isNotification(message)) return null;
      const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : RPC.INTERNAL_ERROR;
      return errResponse(id, code, String(error?.message || error));
    }
  };
}

/** Throw this from a handler to answer with a specific JSON-RPC code. */
export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.rpcCode = code;
  }
}
