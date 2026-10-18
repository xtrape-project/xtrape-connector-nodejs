import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileTokenStore } from "../src/token-store/file-token-store";

describe("FileTokenStore", () => {
  it("saves, loads, and clears issued credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtrape-agent-token-"));
    const file = join(dir, "agent-token.txt");
    const store = new FileTokenStore(file);

    await store.save("agt_123:opstage_agent_secret");

    expect(await readFile(file, "utf8")).toBe("agt_123:opstage_agent_secret");
    expect(await store.load()).toBe("agt_123:opstage_agent_secret");

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("loads legacy token-only files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtrape-agent-token-"));
    const file = join(dir, "agent-token.txt");
    const store = new FileTokenStore(file);

    await store.save("opstage_agent_legacy");

    expect(await store.load()).toBe("opstage_agent_legacy");
  });

  it("loads legacy JSON credential files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtrape-agent-token-"));
    const file = join(dir, "agent-token.json");
    const store = new FileTokenStore(file);

    await writeFile(
      file,
      JSON.stringify({
        agentId: "agt_legacy",
        agentToken: "opstage_agent_secret",
      }),
    );

    expect(await store.load()).toBe("agt_legacy:opstage_agent_secret");
  });
});
