/**
 * Base class for any failure that crosses the Connector ↔ Platform wire. Use
 * `instanceof ConnectorApiError` to catch the family, and the more specific
 * subclasses below when the caller wants to branch on the failure mode.
 *
 * `status === 0` is reserved for transport failures that never reached the
 * Platform (DNS failure, ECONNREFUSED, network timeout, etc.); use
 * `NetworkError` for those.
 *
 * Runtime `error.name` strings deliberately keep their historical values
 * ("AgentApiError", "AgentAuthError") — they are observable behavior
 * (logs, `err.name` matching) and are frozen with the other wire-visible
 * identifiers; only the exported TypeScript symbols were renamed.
 */
export class ConnectorApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

/**
 * The Platform rejected the registration token (expired, revoked, already
 * used, malformed). The Connector cannot proceed without operator action:
 * a fresh registration credential must be created in Panel. The current API
 * still calls this value a registration token.
 */
export class RegistrationError extends ConnectorApiError {
  constructor(message: string, status: number, body?: unknown, code?: string) {
    super(status, message, body, code);
    this.name = "RegistrationError";
  }
}

/**
 * The Platform rejected the persisted agent token (UNAUTHORIZED, Connector
 * REVOKED, Connector DISABLED). The Connector must be re-registered with a
 * fresh registration token before it can resume. The runtime `name` stays
 * "AgentAuthError" for compatibility (see {@link ConnectorApiError}).
 */
export class ConnectorAuthError extends ConnectorApiError {
  constructor(message: string, status: number, body?: unknown, code?: string) {
    super(status, message, body, code);
    this.name = "AgentAuthError";
  }
}

/**
 * Transport-level failure: the request did not reach the Platform, or the
 * Platform's response was not a parseable HTTP envelope. The SDK retries
 * these with exponential backoff; surface to the caller only after the
 * retry budget is exhausted.
 */
export class NetworkError extends ConnectorApiError {
  constructor(message: string, cause?: unknown) {
    super(0, message, undefined, "NETWORK_ERROR");
    this.name = "NetworkError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export class BusDisabledError extends ConnectorApiError {
  constructor(message: string, status: number, body?: unknown) {
    super(status, message, body, "CAPSULE_BUS_DISABLED");
    this.name = "BusDisabledError";
  }
}

export class BusRateLimitedError extends ConnectorApiError {
  constructor(message: string, status: number, body?: unknown) {
    super(status, message, body, "BUS_RATE_LIMITED");
    this.name = "BusRateLimitedError";
  }
}

export class BusDepthExceededError extends ConnectorApiError {
  constructor(message: string, status: number, body?: unknown) {
    super(status, message, body, "BUS_DEPTH_EXCEEDED");
    this.name = "BusDepthExceededError";
  }
}

/**
 * Helper used by ConnectorApiClient to map a parsed Platform error envelope
 * to the right typed subclass. Keeps the request layer free of error-class
 * branching while still giving callers `instanceof RegistrationError`.
 */
export function classifyConnectorApiError(
  status: number,
  message: string,
  body: unknown,
  code: string | undefined,
  path: string,
): ConnectorApiError {
  if (status === 401 && path.endsWith("/register")) return new RegistrationError(message, status, body, code);
  if (status === 401 || status === 403) return new ConnectorAuthError(message, status, body, code);
  if (code === "CAPSULE_BUS_DISABLED") return new BusDisabledError(message, status, body);
  if (code === "BUS_RATE_LIMITED") return new BusRateLimitedError(message, status, body);
  if (code === "BUS_DEPTH_EXCEEDED") return new BusDepthExceededError(message, status, body);
  return new ConnectorApiError(status, message, body, code);
}

// ---------------------------------------------------------------------------
// Deprecated Agent-named aliases (connector-nodejs#79/#80, 0.8.0 concept
// freeze). Same classes/function — `instanceof` and subclassing keep working.
// ---------------------------------------------------------------------------

/** @deprecated Renamed to {@link ConnectorApiError} (connector-nodejs#79, 0.8.0 concept freeze). */
export const AgentApiError = ConnectorApiError;
/** @deprecated Renamed to {@link ConnectorApiError} (connector-nodejs#79, 0.8.0 concept freeze). */
export type AgentApiError = ConnectorApiError;

/** @deprecated Renamed to {@link ConnectorAuthError} (connector-nodejs#79, 0.8.0 concept freeze). */
export const AgentAuthError = ConnectorAuthError;
/** @deprecated Renamed to {@link ConnectorAuthError} (connector-nodejs#79, 0.8.0 concept freeze). */
export type AgentAuthError = ConnectorAuthError;

/** @deprecated Renamed to {@link classifyConnectorApiError} (connector-nodejs#79, 0.8.0 concept freeze). */
export const classifyAgentApiError = classifyConnectorApiError;
