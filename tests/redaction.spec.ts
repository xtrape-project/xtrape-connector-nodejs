import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redaction";

describe("redact", () => {
  it("redacts opstage tokens inside strings", () => {
    expect(redact("opstage_agent_abcDEF123")).toBe("opstage_agent_[REDACTED]");
    expect(redact("opstage_reg_xyz")).toBe("opstage_reg_[REDACTED]");
  });

  it("preserves non-string scalars and null", () => {
    expect(redact(undefined)).toBeUndefined();
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });

  it("redacts sensitive keys but keeps the object shape", () => {
    const result = redact({
      foo: "bar",
      token: "secret-x",
      nested: { agentToken: "y", level: 2 },
    });

    expect(result).toEqual({
      foo: "bar",
      token: "[REDACTED]",
      nested: { agentToken: "[REDACTED]", level: 2 },
    });
  });

  it("redacts arrays of objects", () => {
    expect(
      redact([
        { name: "a", password: "p1" },
        { name: "b", token: "t1" },
      ]),
    ).toEqual([
      { name: "a", password: "[REDACTED]" },
      { name: "b", token: "[REDACTED]" },
    ]);
  });

  it("redacts opstage tokens inside object string values", () => {
    expect(redact({ message: "see opstage_agent_zzz123" })).toEqual({
      message: "see opstage_agent_[REDACTED]",
    });
  });

  it("matches the wider sensitive-key set used by the Platform", () => {
    expect(
      redact({
        cookie: "session=abc",
        apiKey: "k1",
        api_key: "k2",
        generatedKey: "g1",
        rawKey: "r1",
        plainTextKey: "p1",
        normal: "ok",
      }),
    ).toEqual({
      cookie: "[REDACTED]",
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      generatedKey: "[REDACTED]",
      rawKey: "[REDACTED]",
      plainTextKey: "[REDACTED]",
      normal: "ok",
    });
  });
});
