import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeBuildArtifactDigest } from "../src/ce/build-identity";

/**
 * The self-reported build identity (platform-ce#253 ruling): a sha-256 over
 * a canonical manifest of the code under a root — deterministic,
 * content-sensitive, fail-closed on an empty tree, and byte-for-byte the
 * Platform's own construction for the shapes both sides produce.
 */

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "build-identity-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("computeBuildArtifactDigest", () => {
  it("is deterministic and prefixed, and counts the code files it hashed", () => {
    const root = scratch();
    writeFileSync(join(root, "index.js"), "console.log(1)\n");
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "util.js"), "module.exports = 1\n");
    const a = computeBuildArtifactDigest(root);
    const b = computeBuildArtifactDigest(root);
    expect(a.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.artifactDigest).toBe(b.artifactDigest);
    expect(a.files).toBe(2);
  });

  it("changes when any code byte changes — a rebuilt artifact is a new identity", () => {
    const root = scratch();
    writeFileSync(join(root, "index.js"), "console.log(1)\n");
    const before = computeBuildArtifactDigest(root).artifactDigest;
    writeFileSync(join(root, "index.js"), "console.log(2)\n");
    expect(computeBuildArtifactDigest(root).artifactDigest).not.toBe(before);
  });

  it("ignores non-code files and the runtime/state directories the Platform's construction skips", () => {
    const root = scratch();
    writeFileSync(join(root, "index.js"), "console.log(1)\n");
    const before = computeBuildArtifactDigest(root).artifactDigest;
    writeFileSync(join(root, "notes.md"), "prose\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.js"), "x\n");
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "state.json"), "{}\n");
    expect(computeBuildArtifactDigest(root).artifactDigest).toBe(before);
  });

  it("refuses an empty tree — an empty identity would admit nothing real", () => {
    const root = scratch();
    writeFileSync(join(root, "README.md"), "no code\n");
    expect(() => computeBuildArtifactDigest(root)).toThrow(/no code files/);
  });

  it("matches the documented pre-image construction exactly", () => {
    const root = scratch();
    writeFileSync(join(root, "a.js"), "aa");
    writeFileSync(join(root, "b.json"), "{}");
    const fileSha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    const preimage = `{"manifest":[{"path":"a.js","sha256":"${fileSha("aa")}"},{"path":"b.json","sha256":"${fileSha("{}")}"}]}`;
    const expected = `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
    expect(computeBuildArtifactDigest(root).artifactDigest).toBe(expected);
  });
});
