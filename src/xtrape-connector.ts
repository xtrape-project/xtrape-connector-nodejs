
import type { ActionDefinitionInput, Command, ConfigItemInput, HealthReportInput, ReportedService } from "@xtrape/contracts";
import { ConnectorApiClient } from "./client/connector-api-client";
import { ConnectorApiError, NetworkError } from "./client/errors";
import { FileTokenStore } from "./token-store/file-token-store";
import type { ConnectorLogLevel, XtrapeConnectorOptions, ConfigProvider, ConsoleLogger, HealthProvider, RegisteredAction, PublishBusEventInput, PublishBusEventResult, StructuredLogger, TokenStore } from "./types";
import { redact } from "./security/redaction";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

/**
 * If a structured logger is configured, route through it; otherwise call
 * the console-shaped sink. Either way, the caller has already redacted
 * the fields object.
 */
function emitLog(
  consoleSink: ConsoleLogger,
  structured: StructuredLogger | undefined,
  level: ConnectorLogLevel,
  message: string,
  fields: Record<string, unknown> | undefined,
): void {
  if (structured) {
    structured.log({ level, message, fields });
    return;
  }
  if (fields === undefined) consoleSink[level](message);
  else consoleSink[level](message, fields);
}

export class XtrapeConnector {
  private readonly client: ConnectorApiClient;
  private readonly store: TokenStore;
  private readonly logger: ConsoleLogger;
  private readonly structuredLogger?: StructuredLogger;
  private connectorId?: string;
  private token?: string;
  private stopped = true;
  private timers: NodeJS.Timeout[] = [];
  private healthProvider: HealthProvider = () => ({ status: "UNKNOWN" });
  private configProvider: ConfigProvider = () => [];
  private actions = new Map<string, RegisteredAction>();
  constructor(private readonly options: XtrapeConnectorOptions) {
    if (options.worker && options.service) {
      throw new Error("Connector options accept `worker` or legacy `service`, not both.");
    }
    if (!options.worker && !options.service) {
      throw new Error("Connector options require `worker` (or legacy `service`).");
    }
    this.client = new ConnectorApiClient(options.backendUrl);
    this.store = new FileTokenStore(options.tokenStore?.file);
    this.logger = options.logger ?? console;
    this.structuredLogger = options.structuredLogger;
  }
  health(provider: HealthProvider) { this.healthProvider = provider; return this; }
  configs(provider: ConfigProvider) { this.configProvider = provider; return this; }
  action(action: RegisteredAction) { this.actions.set(action.name, action); return this; }
  async start() { this.stopped=false; try { await this.ensureRegistered(); await this.reportWorker(); await this.heartbeat(); await this.pollOnce(); } catch(e) { this.log("error","connector start failed", e); if (this.options.failOnStartError) throw e; }
    if (this.options.autoStartLoops !== false) {
      this.loop("heartbeat", this.options.intervals?.heartbeatMs ?? (this.options.heartbeatIntervalSeconds ?? 30) * 1000, () => this.heartbeat());
      this.loop("worker-report", this.options.intervals?.workerReportMs ?? this.options.intervals?.serviceReportMs ?? 60_000, () => this.reportWorker());
      this.loop("command-poll", this.options.intervals?.commandPollMs ?? (this.options.commandPollIntervalSeconds ?? 5) * 1000, () => this.pollOnce());
    }
  }
  async stop() { this.stopped=true; for (const t of this.timers) clearInterval(t); this.timers=[]; }
  private loop(name:string, ms:number, fn:()=>Promise<void>) { const t=setInterval(async()=>{ if(this.stopped) return; try { await fn(); } catch(e) { this.log("warn",`${name} failed`, e); } }, ms); this.timers.push(t); }
  private async ensureRegistered() { const stored = await this.store.load(); if (stored) { const [connectorId, token] = stored.includes(":") ? stored.split(":",2) : [undefined, stored]; this.connectorId=connectorId; this.token=token; if (this.connectorId) return; }
    if (!this.options.registrationToken) throw new Error("a registration token is required for first registration");
    const worker = this.workerDefinition();
    // `connector` is the canonical identity option; the deprecated `agent`
    // key stays as a compatibility fallback. The wire payload field below is
    // the frozen `agent` registration key, unrelated to the option name.
    // No `mode` field since contracts 0.8.6 (#99 D2): the ophub mode concept
    // is gone — every Widget deploys independently.
    const connectorIdentity = this.options.connector ?? this.options.agent ?? { code: worker.code, name: worker.name, runtime: worker.runtime };
    const res = await this.retry(() => this.client.register({ registrationToken: this.options.registrationToken!, agent: { code: connectorIdentity.code, name: connectorIdentity.name, runtime: connectorIdentity.runtime ?? "nodejs" }, service: this.serviceSnapshot() }));
    this.connectorId=res.agentId; this.token=res.agentToken; await this.store.save(`${this.connectorId}:${this.token}`); this.log("info",`registered connector ${this.connectorId}`);
  }
  private workerDefinition() {
    if (this.options.worker) {
      return this.options.worker;
    }
    return this.options.service;
  }
  private serviceSnapshot(): ReportedService {
    const worker = this.workerDefinition();
    // `agentMode` was removed from the 0.8.6 contract authority together with
    // the mode concept. Drop it even when an older caller still supplies it as
    // passthrough metadata so this SDK never revives the retired wire field.
    const { agentMode: _retiredAgentMode, ...manifestMetadata } = worker.manifest ?? {};
    const manifest = {
      kind: "Worker",
      schemaVersion: "1.0",
      code: worker.code,
      name: worker.name,
      description: worker.description,
      version: worker.version,
      runtime: worker.runtime,
      ...manifestMetadata,
    } as const;
    return {
      code: worker.code,
      name: worker.name,
      description: worker.description,
      version: worker.version,
      runtime: worker.runtime,
      manifest,
      actions: [...this.actions.values()].map(
        ({ handler, prepare, inputSchema, outputSchema, ...action }) =>
          action as ActionDefinitionInput,
      ),
    };
  }
  async runHealth(): Promise<HealthReportInput> { return this.healthProvider(); }
  /** Legacy v0.4 event-routing compatibility hook. Subject to change before v1.0. */
  async publishBusEvent(input: PublishBusEventInput): Promise<PublishBusEventResult> {
    if (!this.connectorId || !this.token) throw new Error("Connector must be started before publishing routed events.");
    const sourceServiceCode = input.sourceServiceCode ?? this.workerDefinition().code;
    const result = await this.retry(() => this.client.publishBusEvent(this.connectorId!, this.token!, { ...input, sourceServiceCode }));
    this.log("info", "experimental bus event published", { eventId: result.eventId, eventType: input.eventType, sourceServiceCode, routedCommands: result.routedCommands.length });
    return result;
  }
  private async reportWorker() { if(!this.connectorId||!this.token) return; const [health, configs] = await Promise.all([this.runHealth(), this.configProvider()]); const worker={...this.serviceSnapshot(), health, configs: configs as ConfigItemInput[]}; await this.retry(()=>this.client.reportWorkers(this.connectorId!, this.token!, { workers:[worker] })); }
  private async heartbeat() { if(!this.connectorId||!this.token) return; await this.retry(()=>this.client.heartbeat(this.connectorId!, this.token!, {})); }
  private async pollOnce() { if(!this.connectorId||!this.token) return; const commands = await this.retry(()=>this.client.pollCommands(this.connectorId!, this.token!)); for (const c of commands) await this.execute(c); }
  private async execute(command: Command) { const startedAt=new Date().toISOString(); const action=this.actions.get(command.actionName); if(!action){ await this.client.reportResult(this.connectorId!, this.token!, command.id, { success:false, message:`No handler registered for action ${command.actionName}`, error:{ code:"ACTION_HANDLER_NOT_FOUND" }, startedAt, finishedAt:new Date().toISOString() }); return; }
    try {
      if (command.type === "ACTION_PREPARE") {
        const out = action.prepare ? await Promise.resolve(action.prepare()) : this.defaultPrepare(action);
        await this.client.reportResult(this.connectorId!, this.token!, command.id, { success:true, data: out as Record<string, unknown>, startedAt, finishedAt:new Date().toISOString() });
        return;
      }
      // `timeoutSeconds` is disclosure metadata only (contracts 0.8.6). The
      // generic Connector must not synthesize a deadline or stop business
      // execution because elapsed time passed; only the action or an explicit
      // lifecycle signal can determine its terminal outcome.
      const out = await Promise.resolve(action.handler(command.payload ?? {}));
      const result = out as { success?: boolean; message?: string; data?: Record<string, unknown>; error?: Record<string, unknown> };
      const success = result.success !== false;
      await this.client.reportResult(this.connectorId!, this.token!, command.id, { success, message: result.message, data: result.data ?? (success ? out as Record<string, unknown> : undefined), error: result.error, startedAt, finishedAt:new Date().toISOString() });
    }
    catch(e:any){ await this.client.reportResult(this.connectorId!, this.token!, command.id, { success:false, message:e?.message ?? "Action failed", error:{ code:"ACTION_FAILED", message:e?.message ?? String(e) }, startedAt, finishedAt:new Date().toISOString() }); }
  }
  private defaultPrepare(action: RegisteredAction): Record<string, unknown> { const { handler:_handler, prepare:_prepare, ...meta } = action; return { action: meta as Record<string, unknown>, initialPayload: this.initialPayloadFromSchema(action.inputSchema), currentState: {} }; }
  private initialPayloadFromSchema(schema: unknown): Record<string, unknown> { const props = schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as { properties?: unknown }).properties : undefined; if(!props || typeof props !== "object" || Array.isArray(props)) return {}; return Object.fromEntries(Object.entries(props as Record<string,{default?:unknown; type?: string|string[]}>).map(([k,m])=>{ if(m.default!==undefined) return [k,m.default]; if(m.type==="number"||m.type==="integer") return [k,0]; if(m.type==="boolean") return [k,false]; if(m.type==="array") return [k,[]]; if(m.type==="object") return [k,{}]; return [k,""]; })); }
  private async retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e: unknown) {
        last = e;
        // Retry transport failures (no HTTP response) and 5xx server errors.
        // 4xx including registration / auth failures need operator action;
        // surface them immediately so the caller can react.
        if (e instanceof NetworkError) {
          // fall through to backoff
        } else if (e instanceof ConnectorApiError && e.status >= 500) {
          // fall through to backoff
        } else {
          throw e;
        }
        await sleep(Math.min(1000 * 2 ** i, 15000));
      }
    }
    throw last;
  }
  private log(level: ConnectorLogLevel, msg: string, obj?: unknown): void {
    // Always normalize the optional context to a record before passing to a
    // structured sink: errors are coerced to `{ message, name, stack? }`
    // because instances of Error don't survive JSON.stringify.
    const fields = obj === undefined ? undefined : (this.normalizeFields(obj) as Record<string, unknown>);
    const redacted = fields ? (redact(fields) as Record<string, unknown>) : undefined;
    emitLog(this.logger, this.structuredLogger, level, msg, redacted);
  }

  private normalizeFields(obj: unknown): Record<string, unknown> {
    if (obj instanceof Error) {
      return { error: { message: obj.message, name: obj.name, stack: obj.stack } };
    }
    if (typeof obj === "object" && obj !== null) return obj as Record<string, unknown>;
    return { value: obj };
  }
}

// Re-export the log record types so consumers can implement structured loggers
// against a typed contract.
export type { ConnectorLogLevel, ConnectorLogRecord, AgentLogLevel, AgentLogRecord, StructuredLogger, ConsoleLogger } from "./types";
