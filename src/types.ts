import type { ActionDefinitionInput, ConfigItemInput, HealthReportInput, ReportedService, RuntimeKind, ActionPrepareResult, PublishBusEventRequest, PublishBusEventResponse, RegisterConnectorRequest as WireRegisterConnectorRequest, RegisterConnectorResponse as WireRegisterConnectorResponse, ConnectorHeartbeatRequest as WireConnectorHeartbeatRequest } from "@xtrape/contracts";

// ---------------------------------------------------------------------------
// Contracts DTO facade (connector-nodejs#79/#80). Since contracts 0.8.6 the
// Connector-named DTOs are the wire primaries. This SDK re-exports them as its
// canonical surface while retaining Agent-named aliases for SDK compatibility;
// frozen JSON keys such as `agent`, `agentId`, and `agentToken` stay unchanged.
// ---------------------------------------------------------------------------

/** Canonical name for the registration request DTO (wire shape unchanged). */
export type RegisterConnectorRequest = WireRegisterConnectorRequest;
/** @deprecated Use {@link RegisterConnectorRequest} (connector-nodejs#79, 0.8.0 concept freeze). Same shape; since contracts 0.8.6 the wire primary is Connector-named too. */
export type RegisterAgentRequest = WireRegisterConnectorRequest;

/** Canonical name for the registration response DTO (wire shape unchanged). */
export type RegisterConnectorResponse = WireRegisterConnectorResponse;
/** @deprecated Use {@link RegisterConnectorResponse} (connector-nodejs#79, 0.8.0 concept freeze). Same shape; since contracts 0.8.6 the wire primary is Connector-named too. */
export type RegisterAgentResponse = WireRegisterConnectorResponse;

/** Canonical name for the heartbeat request DTO (wire shape unchanged). */
export type ConnectorHeartbeatRequest = WireConnectorHeartbeatRequest;
/** @deprecated Use {@link ConnectorHeartbeatRequest} (connector-nodejs#79, 0.8.0 concept freeze). Same shape; since contracts 0.8.6 the wire primary is Connector-named too. */
export type AgentHeartbeatRequest = WireConnectorHeartbeatRequest;

export type ConnectorMode = "embedded";
/** @deprecated Renamed to {@link ConnectorMode} (connector-nodejs#79, 0.8.0 concept freeze). */
export type AgentMode = ConnectorMode;
export type ActionHandler = (payload: Record<string, unknown>) => Promise<{ success?: boolean; message?: string; data?: Record<string, unknown>; error?: Record<string, unknown> } | Record<string, unknown>>;
export type ActionPrepareHandler = () => Promise<ActionPrepareResult | Record<string, unknown>> | ActionPrepareResult | Record<string, unknown>;

/**
 * Log level emitted by the SDK. Aligns with the four standard `Console`
 * methods so a plain `console` works as a logger with no adapter.
 */
export type ConnectorLogLevel = "debug" | "info" | "warn" | "error";
/** @deprecated Renamed to {@link ConnectorLogLevel} (connector-nodejs#79, 0.8.0 concept freeze). */
export type AgentLogLevel = ConnectorLogLevel;

/**
 * Structured log record passed to a `StructuredLogger`. The SDK populates
 * `level` and `message`; `fields` carries an already-redacted Record of
 * runtime context (agent id, error code, retry count, etc.).
 */
export interface ConnectorLogRecord {
  level: ConnectorLogLevel;
  message: string;
  fields?: Record<string, unknown>;
}
/** @deprecated Renamed to {@link ConnectorLogRecord} (connector-nodejs#79, 0.8.0 concept freeze). */
export type AgentLogRecord = ConnectorLogRecord;

/**
 * A structured log sink. Useful when the host wants to forward SDK events
 * into a JSON-line logger, pino, OpenTelemetry, or a custom collector
 * without losing the per-field context to `console.warn`'s positional
 * argument list.
 */
export interface StructuredLogger {
  log(record: ConnectorLogRecord): void;
}

/**
 * Console-shaped logger (subset of Node's `Console`). The SDK defaults to
 * the global `console` when neither option is set; if both are provided,
 * `structuredLogger` wins.
 */
export type ConsoleLogger = Pick<Console, "debug" | "info" | "warn" | "error">;

export interface WorkerDefinition {
  code: string;
  name: string;
  description?: string;
  version: string;
  runtime: RuntimeKind;
  manifest?: Record<string, unknown>;
}

interface XtrapeConnectorOptionsBase {
  backendUrl: string;
  registrationToken?: string;
  tokenStore?: { file?: string };
  /**
   * Optional explicit Connector identity (code/name/runtime) reported at
   * registration. If omitted, the SDK derives it from `worker`. The wire
   * registration payload keeps its frozen `agent` field name.
   */
  connector?: { code: string; name?: string; runtime?: RuntimeKind };
  /** @deprecated Renamed to `connector` (connector-nodejs#79, 0.8.0 concept freeze). If both are set, `connector` wins. */
  agent?: { code: string; name?: string; runtime?: RuntimeKind };
  intervals?: {
    heartbeatMs?: number;
    commandPollMs?: number;
    /** Canonical Worker Runtime Report interval. */
    workerReportMs?: number;
    /** @deprecated Compatibility alias for `workerReportMs`. */
    serviceReportMs?: number;
  };
  heartbeatIntervalSeconds?: number;
  commandPollIntervalSeconds?: number;
  autoStartLoops?: boolean;
  /** Console-shaped sink; default is the global `console`. */
  logger?: ConsoleLogger;
  /**
   * Structured sink. If provided, takes precedence over `logger`. The SDK
   * still applies its own redaction before calling `log()`, so the host
   * can route records as-is to a JSON stream.
   */
  structuredLogger?: StructuredLogger;
  failOnStartError?: boolean;
}

/** Canonical Embedded Connector options: exactly one runtime unit via `worker`. */
export type WorkerConnectorOptions = XtrapeConnectorOptionsBase & {
  worker: WorkerDefinition;
  /** @deprecated Legacy alias; do not combine with `worker`. */
  service?: never;
};
/** @deprecated Renamed to {@link WorkerConnectorOptions} (connector-nodejs#79, 0.8.0 concept freeze). */
export type WorkerAgentOptions = WorkerConnectorOptions;

/** Legacy Embedded Connector options: exactly one runtime unit via `service`. */
export type LegacyServiceConnectorOptions = XtrapeConnectorOptionsBase & {
  /** @deprecated Legacy compatibility alias for `worker`. */
  service: WorkerDefinition;
  worker?: never;
};
/** @deprecated Renamed to {@link LegacyServiceConnectorOptions} (connector-nodejs#79, 0.8.0 concept freeze). */
export type LegacyServiceAgentOptions = LegacyServiceConnectorOptions;

export type XtrapeConnectorOptions = WorkerConnectorOptions | LegacyServiceConnectorOptions;
/** @deprecated Renamed to {@link XtrapeConnectorOptions} (agent-nodejs#75, 0.8.0 concept freeze). */
export type XtrapeAgentOptions = XtrapeConnectorOptions;
export type HealthProvider = () => Promise<HealthReportInput> | HealthReportInput;
export type ConfigProvider = () => Promise<ConfigItemInput[]> | ConfigItemInput[];
export interface RegisteredAction extends ActionDefinitionInput { handler: ActionHandler; prepare?: ActionPrepareHandler; }
export interface TokenStore { load(): Promise<string | null>; save(token: string): Promise<void>; clear(): Promise<void>; }
export type ServiceSnapshot = ReportedService;
export type WorkerSnapshot = ReportedService;

//


/** Legacy v0.4 event-routing publish input. Subject to change before v1.0. */
export type PublishBusEventInput = Omit<PublishBusEventRequest, "sourceServiceCode" | "experimental"> & {
  sourceServiceCode?: string;
  experimental?: PublishBusEventRequest["experimental"];
};

export type PublishBusEventResult = PublishBusEventResponse;
