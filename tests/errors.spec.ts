import { describe, expect, it } from "vitest";
import {
  ConnectorApiError,
  ConnectorAuthError,
  NetworkError,
  RegistrationError,
} from "../src/client/errors";
import { classifyConnectorApiError } from "../src/client/errors";

describe("typed connector errors", () => {
  it("subclasses retain the ConnectorApiError family", () => {
    const r = new RegistrationError("token revoked", 401, undefined, "REGISTRATION_TOKEN_INVALID");
    const a = new ConnectorAuthError("forbidden", 403, undefined, "AGENT_DISABLED");
    const n = new NetworkError("ECONNREFUSED");
    for (const e of [r, a, n]) expect(e).toBeInstanceOf(ConnectorApiError);
    expect(r.name).toBe("RegistrationError");
    expect(a.name).toBe("AgentAuthError");
    expect(n.name).toBe("NetworkError");
  });

  it("classifyConnectorApiError maps register-401 to RegistrationError", () => {
    const err = classifyConnectorApiError(
      401,
      "Invalid registration token.",
      { error: { code: "REGISTRATION_TOKEN_INVALID" } },
      "REGISTRATION_TOKEN_INVALID",
      "/api/agents/register",
    );
    expect(err).toBeInstanceOf(RegistrationError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("REGISTRATION_TOKEN_INVALID");
  });

  it("classifyConnectorApiError maps non-register 401/403 to ConnectorAuthError", () => {
    const u = classifyConnectorApiError(401, "Invalid Agent token.", undefined, "UNAUTHORIZED", "/api/agents/agt_x/heartbeat");
    const f = classifyConnectorApiError(403, "Agent is disabled.", undefined, "AGENT_DISABLED", "/api/agents/agt_x/commands");
    expect(u).toBeInstanceOf(ConnectorAuthError);
    expect(f).toBeInstanceOf(ConnectorAuthError);
    expect(u).not.toBeInstanceOf(RegistrationError);
  });

  it("classifyConnectorApiError keeps 4xx-non-auth as plain ConnectorApiError", () => {
    const conflict = classifyConnectorApiError(409, "Conflict", undefined, "CONFLICT", "/api/agents/agt_x/commands");
    expect(conflict).toBeInstanceOf(ConnectorApiError);
    expect(conflict).not.toBeInstanceOf(ConnectorAuthError);
    expect(conflict).not.toBeInstanceOf(RegistrationError);
  });

  it("NetworkError carries cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new NetworkError("Failed to reach /heartbeat", cause);
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK_ERROR");
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});
