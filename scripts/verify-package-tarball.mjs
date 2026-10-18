#!/usr/bin/env node
/**
 * Verify a packed npm tarball before publishing it.
 *
 * Usage: node scripts/verify-package-tarball.mjs <tarball> <version> <sentinelA,sentinelB,...>
 *
 * Asserts, on the exact tarball bytes that will be uploaded:
 *   1. package.json version matches the release version;
 *   2. the dual-format dist entries exist (dist/index.js/.cjs/.d.ts);
 *   3. the CJS entry loads and exports every sentinel name.
 *
 * The sentinel list must contain exports introduced in the current minor line,
 * so a stale dist (the contracts 0.7.0 incident, contracts#47) fails here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const [tarball, version, sentinelCsv] = process.argv.slice(2);
if (!tarball || !version || !sentinelCsv) {
  console.error("usage: verify-package-tarball.mjs <tarball> <version> <sentinelA,sentinelB,...>");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "tarball-verify-"));
execFileSync("tar", ["-xzf", tarball, "-C", dir]);
const pkgRoot = join(dir, "package");

// The tarball ships without its runtime dependencies; resolve them from the
// repository install the workflow just ran.
symlinkSync(join(process.cwd(), "node_modules"), join(pkgRoot, "node_modules"), "dir");

const require = createRequire(import.meta.url);
const pkg = require(join(pkgRoot, "package.json"));
assert.strictEqual(pkg.version, version, `tarball version ${pkg.version} != release version ${version}`);

for (const f of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts"]) {
  assert(existsSync(join(pkgRoot, f)), `missing ${f} in tarball`);
}

const mod = require(join(pkgRoot, "dist/index.cjs"));
const sentinels = sentinelCsv.split(",").map((s) => s.trim()).filter(Boolean);
const missing = sentinels.filter((name) => !(name in mod));
assert(missing.length === 0, `stale dist: missing sentinel exports: ${missing.join(", ")}`);

console.log(`tarball OK: ${pkg.name}@${pkg.version}, ${Object.keys(mod).length} exports, sentinels: ${sentinels.join(", ")}`);
