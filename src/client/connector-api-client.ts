import type { ReportCommandResultRequest, ServiceReportRequest, Command, ReportedService } from "@xtrape/contracts";
import type { ConnectorHeartbeatRequest, PublishBusEventInput, PublishBusEventResult, RegisterConnectorRequest, RegisterConnectorResponse } from "../types";
import { ConnectorApiError, NetworkError, classifyConnectorApiError } from "./errors";

/**
 * HTTP client for the control-plane Connector API. Method signatures use the
 * canonical Connector-named DTO facade and `connectorId` parameter names;
 * the wire is untouched — routes stay under `/api/agents/*` and the JSON
 * payload keys (`agent`, `agentId`, `agentToken`, ...) are frozen.
 */
export class ConnectorApiClient {
  constructor(private readonly backendUrl: string) {}

  private url(path: string) { return new URL(path, this.backendUrl).toString(); }

  private async request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    let res: Response;
    try {
      res = await fetch(this.url(path), { ...init, headers });
    } catch (cause) {
      // fetch threw before getting an HTTP response — DNS, ECONNREFUSED, abort,
      // timeout. Surface as NetworkError so the retry loop can back off and
      // callers can branch on `instanceof NetworkError`.
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new NetworkError(`Failed to reach ${path}: ${reason}`, cause);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON response from the Platform (rare; reverse-proxy HTML error pages).
      body = { error: { message: res.statusText } };
    }
    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: string } } | undefined)?.error;
      throw classifyConnectorApiError(res.status, err?.message ?? res.statusText, body, err?.code, path);
    }
    return ((body as { data?: T } | undefined)?.data ?? (body as T)) as T;
  }

  register(req: RegisterConnectorRequest) {
    return this.request<RegisterConnectorResponse>("/api/agents/register", { method: "POST", body: JSON.stringify(req) });
  }

  heartbeat(connectorId: string, token: string, req: ConnectorHeartbeatRequest) {
    return this.request(`/api/agents/${connectorId}/heartbeat`, { method: "POST", token, body: JSON.stringify(req) });
  }

  reportServices(connectorId: string, token: string, req: ServiceReportRequest) {
    return this.request(`/api/agents/${connectorId}/services/report`, { method: "POST", token, body: JSON.stringify(req) });
  }

  /** Report Workers through the canonical endpoint, with a legacy fallback. */
  async reportWorkers(connectorId: string, token: string, req: { workers: ReportedService[] }) {
    try {
      return await this.request(`/api/agents/${connectorId}/workers/report`, { method: "POST", token, body: JSON.stringify(req) });
    } catch (error) {
      if (!(error instanceof ConnectorApiError) || error.status !== 404) throw error;
      return this.reportServices(connectorId, token, { services: req.workers });
    }
  }

  pollCommands(connectorId: string, token: string) {
    return this.request<Command[]>(`/api/agents/${connectorId}/commands`, { method: "GET", token });
  }

  reportResult(connectorId: string, token: string, commandId: string, req: ReportCommandResultRequest) {
    return this.request(`/api/agents/${connectorId}/commands/${commandId}/result`, { method: "POST", token, body: JSON.stringify(req) });
  }

  /** Legacy v0.4 event-routing compatibility hook. Subject to change before v1.0. */
  publishBusEvent(connectorId: string, token: string, req: PublishBusEventInput) {
    return this.request<PublishBusEventResult>(`/api/agents/${connectorId}/bus/events`, { method: "POST", token, body: JSON.stringify({ ...req, experimental: req.experimental ?? "v0.4-experimental" }) });
  }
}

/** @deprecated Renamed to {@link ConnectorApiClient} (connector-nodejs#79, 0.8.0 concept freeze). Same class — `instanceof` keeps working. */
export const AgentApiClient = ConnectorApiClient;
/** @deprecated Renamed to {@link ConnectorApiClient} (connector-nodejs#79, 0.8.0 concept freeze). */
export type AgentApiClient = ConnectorApiClient;

// Re-export so consumers can `import { ConnectorApiError } from "./client/connector-api-client"` too.
export { ConnectorApiError, AgentApiError } from "./errors";
