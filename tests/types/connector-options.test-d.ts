import type { XtrapeConnectorOptions } from "../../src/types.js";

const workerDefinition = {
  code: "demo-worker",
  name: "Demo Worker",
  version: "1.0.0",
  runtime: "nodejs" as const,
};

// @ts-expect-error worker or legacy service is required
const missingRuntimeUnit: XtrapeConnectorOptions = {
  backendUrl: "http://localhost:8080",
};

const withWorker: XtrapeConnectorOptions = {
  backendUrl: "http://localhost:8080",
  worker: workerDefinition,
};

const withLegacyService: XtrapeConnectorOptions = {
  backendUrl: "http://localhost:8080",
  service: workerDefinition,
};

// @ts-expect-error worker and legacy service are mutually exclusive
const withBoth: XtrapeConnectorOptions = {
  backendUrl: "http://localhost:8080",
  worker: workerDefinition,
  service: workerDefinition,
};

void missingRuntimeUnit;
void withWorker;
void withLegacyService;
void withBoth;

// connector-nodejs#79: deprecated Agent* type aliases stay assignable both ways.
import type { AgentLogLevel, AgentLogRecord, AgentMode, ConnectorLogLevel, ConnectorLogRecord, ConnectorMode } from "../../src/types.js";

const canonicalMode: ConnectorMode = "embedded";
const aliasMode: AgentMode = canonicalMode;
const canonicalLevel: ConnectorLogLevel = "warn";
const aliasLevel: AgentLogLevel = canonicalLevel;
const canonicalRecord: ConnectorLogRecord = { level: "info", message: "ok" };
const aliasRecord: AgentLogRecord = canonicalRecord;
const backToCanonical: ConnectorLogRecord = aliasRecord;

void aliasMode;
void aliasLevel;
void backToCanonical;

// connector-nodejs#80 review 1: remaining deprecated alias pairs stay
// assignable both ways, and the options base accepts `connector` (primary)
// alongside the deprecated `agent` identity key.
import type {
  LegacyServiceAgentOptions,
  LegacyServiceConnectorOptions,
  WorkerAgentOptions,
  WorkerConnectorOptions,
} from "../../src/types.js";
import type { CeServiceAgentOptions, CeServiceConnectorOptions } from "../../src/ce/index.js";

const canonicalWorkerOptions: WorkerConnectorOptions = {
  backendUrl: "http://localhost:8080",
  worker: workerDefinition,
  connector: { code: "demo-connector" },
};
const aliasWorkerOptions: WorkerAgentOptions = canonicalWorkerOptions;
const backToWorkerOptions: WorkerConnectorOptions = aliasWorkerOptions;

const canonicalLegacyOptions: LegacyServiceConnectorOptions = {
  backendUrl: "http://localhost:8080",
  service: workerDefinition,
  agent: { code: "legacy-agent" },
};
const aliasLegacyOptions: LegacyServiceAgentOptions = canonicalLegacyOptions;
const backToLegacyOptions: LegacyServiceConnectorOptions = aliasLegacyOptions;

declare const ceCanonicalOptions: CeServiceConnectorOptions;
const ceAliasOptions: CeServiceAgentOptions = ceCanonicalOptions;
const ceBackToCanonical: CeServiceConnectorOptions = ceAliasOptions;

void backToWorkerOptions;
void backToLegacyOptions;
void ceBackToCanonical;

// connector-nodejs#80 review 2: contracts DTO facade aliases stay assignable
// both ways (SDK-side canonical names over the contracts Agent-named DTOs).
import type {
  AgentHeartbeatRequest,
  ConnectorHeartbeatRequest,
  RegisterAgentRequest,
  RegisterAgentResponse,
  RegisterConnectorRequest,
  RegisterConnectorResponse,
} from "../../src/types.js";

declare const canonicalRegisterReq: RegisterConnectorRequest;
const aliasRegisterReq: RegisterAgentRequest = canonicalRegisterReq;
const backToRegisterReq: RegisterConnectorRequest = aliasRegisterReq;

declare const canonicalRegisterRes: RegisterConnectorResponse;
const aliasRegisterRes: RegisterAgentResponse = canonicalRegisterRes;
const backToRegisterRes: RegisterConnectorResponse = aliasRegisterRes;

declare const canonicalHeartbeatReq: ConnectorHeartbeatRequest;
const aliasHeartbeatReq: AgentHeartbeatRequest = canonicalHeartbeatReq;
const backToHeartbeatReq: ConnectorHeartbeatRequest = aliasHeartbeatReq;

void backToRegisterReq;
void backToRegisterRes;
void backToHeartbeatReq;
