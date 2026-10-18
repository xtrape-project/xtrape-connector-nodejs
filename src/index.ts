import { XtrapeConnector } from "./xtrape-connector";
export { XtrapeConnector };
/** @deprecated Renamed to {@link XtrapeConnector} (agent-nodejs#75, 0.8.0 concept freeze). Will be removed in a later 0.8.x release. */
export const XtrapeAgent = XtrapeConnector;
/** @deprecated Renamed to {@link XtrapeConnector} (agent-nodejs#75, 0.8.0 concept freeze). */
export type XtrapeAgent = XtrapeConnector;
export { FileTokenStore } from "./token-store/file-token-store";
// Canonical client name + deprecated alias (connector-nodejs#79).
export { ConnectorApiClient, AgentApiClient } from "./client/connector-api-client";
export {
  ConnectorApiError,
  ConnectorAuthError,
  // Deprecated aliases of the two classes above (connector-nodejs#79).
  AgentApiError,
  AgentAuthError,
  RegistrationError,
  NetworkError,
  BusDisabledError,
  BusRateLimitedError,
  BusDepthExceededError,
} from "./client/errors";
export type * from "./types";

// Xtrape CE Phase 0 service connector (register / heartbeat / message reply).
// CeServiceAgent / CeServiceAgentOptions are deprecated aliases (connector-nodejs#79).
export { CeServiceConnector, CeServiceAgent, CePlatformHttpError } from "./ce";
export type { CeServiceConnectorOptions, CeServiceAgentOptions, CeMessageHandler, CeMessageReply, CommandReportAck, CeSchemaRecordDefinition, CeAuthorityDescriptor } from "./ce";
// One-call HTTP bootstrap for an xtrape-service (register + /messages + heartbeat).
export { serveCeService } from "./ce/serve";
export { computeBuildArtifactDigest } from "./ce/build-identity";
export type { BuildArtifactIdentity } from "./ce/build-identity";
export type { CeActionPrepareResult, CeServiceActionDefinition, CeExecuteContext, CePrepareContext, CeReviewContext, CeReviewResult, ServeCeServiceOptions, ServeCeServiceHandle } from "./ce/serve";
export { REVIEW_FEATURE, reviewFaceFor } from "./ce/serve";
export { COMMAND_ORIGIN_HEADER } from "@xtrape/contracts";
// World A long-poll delivery loop (agent-nodejs#44, contracts 0.7.4).
export { CeLongPollLoop } from "./ce/long-poll";
export type { CeLongPollHandlers, CeLongPollOptions } from "./ce/long-poll";
