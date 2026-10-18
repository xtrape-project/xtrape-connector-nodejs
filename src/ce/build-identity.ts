import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The Widget's self-reported build identity (owner ruling on
 * platform-ce#253; arch/16 §17.1 item 10; manifest `build.artifactDigest`).
 *
 * Same construction the Platform applies to itself
 * (`platform-build-identity.ts`): a sha-256 over a canonical manifest of the
 * code the process runs — sorted relative paths, each with the sha-256 of
 * its bytes — computed once at startup. A different build yields a different
 * digest; nothing here is declared by hand, the hash is computed from bytes.
 *
 * Round-1 trust level is SELF-REPORTED: the Platform admits this value as
 * the target's artifact identity because the deployment operator ran this
 * code. The recorded evolution (self-reported → asset-library issuance →
 * anchor) replaces the trust SOURCE of the value in later rounds; this
 * computation and the field shape stay.
 *
 * Serialization note: the pre-image is a recursive sorted-key JSON
 * rendering of `{manifest: [{path, sha256}, …]}`. For this value domain —
 * plain object keys and JSON-string-escaped paths/hex — it coincides with
 * RFC 8785 JCS output; the value is stored verbatim by the Platform and not
 * recomputed by another implementation in this round.
 */

const CODE_FILE = /\.(js|mjs|cjs|ts|json)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "generated", "data", "logs", "conf"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function walk(dir: string, root: string, out: Array<{ path: string; sha256: string }>): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (st.isFile() && CODE_FILE.test(name)) {
      out.push({
        path: relative(root, full).split(sep).join("/"),
        sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
      });
    }
  }
}

export interface BuildArtifactIdentity {
  /** `sha256:<64 hex>` — the manifest `build.artifactDigest` value. */
  readonly artifactDigest: string;
  /** The root the manifest was taken from (as given). */
  readonly root: string;
  /** Number of files in the manifest. */
  readonly files: number;
}

/**
 * Compute the identity of the code under `root` — for a Widget, the
 * directory its built module tree lives in (typically `dist/`, e.g.
 * `path.join(__dirname)` from the entry module). Throws when the root holds
 * no code files: an empty identity would "admit" nothing real.
 */
export function computeBuildArtifactDigest(root: string): BuildArtifactIdentity {
  const manifest: Array<{ path: string; sha256: string }> = [];
  walk(root, root, manifest);
  if (manifest.length === 0) throw new Error(`build identity: no code files under ${root}`);
  const digest = createHash("sha256").update(canonical({ manifest }), "utf8").digest("hex");
  return Object.freeze({ artifactDigest: `sha256:${digest}`, root, files: manifest.length });
}
