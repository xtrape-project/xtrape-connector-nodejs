import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const summarizer = fileURLToPath(
  new URL("../.forgejo/workflows/publish-summarize.mjs", import.meta.url),
);
const workflowPath = fileURLToPath(
  new URL("../.forgejo/workflows/npm-publish.yml", import.meta.url),
);

function summarize(raw) {
  const dir = mkdtempSync(join(tmpdir(), "publish-summary-"));
  const outputPath = join(dir, "publish-out.txt");
  const payloadPath = join(dir, "payload.json");
  writeFileSync(outputPath, raw);

  execFileSync(process.execPath, [summarizer], {
    env: {
      ...process.env,
      CI_SHA: "fixture-sha",
      PUBLISH_OUTPUT_PATH: outputPath,
      PUBLISH_PAYLOAD_PATH: payloadPath,
    },
  });

  return JSON.parse(readFileSync(payloadPath, "utf8")).body;
}

describe("publish failure summarizer", () => {
  it("keeps only safe publish diagnostics", () => {
    const body = summarize(`
npm error code E401
npm error 401 https://user:hunter2@registry.example.invalid/package
Authorization: Bearer secret-token-value
package.json is 0.7.4 but the release asks for 0.7.5
Forgejo already has @xtrape/contracts@0.7.5 with different tarball integrity
`);

    assert.match(body, /npm error code E401/);
    assert.match(body, /npm error HTTP 401/);
    assert.match(body, /package\.json is 0\.7\.4 but the release asks for 0\.7\.5/);
    assert.match(body, /Forgejo already has the target version/);
    assert.match(
      body,
      /raw capture is not posted to the issue; full output remains in the protected Actions log/,
    );
    assert.doesNotMatch(body, /raw logs never leave the runner/);
    assert.doesNotMatch(body, /hunter2/);
    assert.doesNotMatch(body, /secret-token-value/);
    assert.doesNotMatch(body, /registry\.example\.invalid/);
  });

  it("summarizes only the fixed Forgejo probe label and status", () => {
    for (const status of ["401", "403", "404", "000"]) {
      const body = summarize(`
Forgejo auth probe failed: HTTP ${status}
Authorization: token top-secret-registry-token
https://user:password@forgejo.example.invalid/private-response
response body with private details
`);

      assert.match(body, new RegExp(`Forgejo auth probe HTTP ${status}`));
      assert.doesNotMatch(body, /top-secret-registry-token/);
      assert.doesNotMatch(body, /password/);
      assert.doesNotMatch(body, /forgejo\.example\.invalid/);
      assert.doesNotMatch(body, /private details/);
    }
  });

  it("summarizes read-back gate failures per registry and class, leaking nothing else", () => {
    for (const registry of ["npmjs", "Forgejo"]) {
      for (const clazz of ["integrity mismatch", "not readable within the per-registry window"]) {
        const body = summarize(`
read-back gate failed: ${registry} ${clazz}
detail: remote integrity differs from the packed tarball (values withheld from the issue; see this log)
npmjs serves @xtrape/connector@0.8.1 sha512-SECRETINTEGRITYVALUEAAAAAAAAAAAA
`);
        assert.match(body, new RegExp(`read-back gate: ${registry} ${clazz.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
        assert.doesNotMatch(body, /@xtrape\/connector/);
        assert.doesNotMatch(body, /SECRETINTEGRITYVALUE/);
        assert.doesNotMatch(body, /remote integrity differs/);
      }
    }
  });

  it("does not keep a successful read-back as failure noise", () => {
    const body = summarize("npmjs read-back verified on attempt 3\nunknown later failure\n");

    assert.match(body, /no line matched the safe summary allowlist/);
    assert.doesNotMatch(body, /read-back verified/);
  });

  it("does not retain a successful Forgejo probe as failure noise", () => {
    const body = summarize("Forgejo auth probe: HTTP 200\nunknown later failure\n");

    assert.match(body, /no line matched the safe summary allowlist/);
    assert.doesNotMatch(body, /HTTP 200/);
  });

  it("uses the fail-closed fallback when no line matches", () => {
    const body = summarize("arbitrary registry response containing private details\n");

    assert.match(body, /no line matched the safe summary allowlist/);
    assert.doesNotMatch(body, /private details/);
  });

  it("does not let successful earlier steps mask an unknown publish failure", () => {
    const body = summarize(`
Test Files 1 passed (1)
Tests 91 passed (91)
npmjs does not have @xtrape/contracts@0.7.5
Forgejo does not have @xtrape/contracts@0.7.5
npm error unexpected registry response containing private details
`);

    assert.match(body, /no line matched the safe summary allowlist/);
    assert.doesNotMatch(body, /91 passed/);
    assert.doesNotMatch(body, /does not have/);
    assert.doesNotMatch(body, /private details/);
  });

  it("cannot escape the Markdown fence through a kept filename", () => {
    const body = summarize("FAIL tests/```escape.test.ts\n");

    assert.match(body, /FAIL tests\/escape\.test\.ts/);
    assert.equal(body.match(/```/g)?.length, 2);
  });

  it("deletes registry stderr immediately when the shell exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-trap-"));
    const errorFile = join(dir, "registry-error.txt");

    execFileSync("bash", [
      "-c",
      'set -euo pipefail; ERROR_FILE="$1"; : > "$ERROR_FILE"; trap \'rm -f "$ERROR_FILE"\' EXIT',
      "bash",
      errorFile,
    ]);

    assert.equal(existsSync(errorFile), false);
  });

  it("captures and cleans every release diagnostic", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const reset = workflow.indexOf(': > "$RUNNER_TEMP/publish-out.txt"');
    const firstCapture = workflow.indexOf('exec > >(tee -a "$RUNNER_TEMP/publish-out.txt") 2>&1');
    assert.notEqual(reset, -1, "workflow does not reset the diagnostics file");
    assert.ok(reset < firstCapture, "diagnostics must be reset before the first captured step");
    assert.match(workflow, /umask 077/);
    assert.ok(
      workflow.includes('PUBLISH_OUTPUT_PATH="$RUNNER_TEMP/publish-out.txt" ' + "\\"),
    );
    assert.ok(
      workflow.includes('PUBLISH_PAYLOAD_PATH="$RUNNER_TEMP/payload.json" ' + "\\"),
    );
    assert.ok(workflow.includes('--data-binary "@$RUNNER_TEMP/payload.json"'));
    assert.match(workflow, /- name: Cleanup publish credentials and diagnostics[\s\S]+if: always\(\)/);
    const gate = workflow.indexOf("- name: Post-publish read-back gate");
    assert.notEqual(gate, -1, "workflow lost the post-publish read-back gate");
    const gateBlock = workflow.slice(gate, workflow.indexOf("- name:", gate + 1));
    assert.ok(
      gateBlock.includes('exec > >(tee -a "$RUNNER_TEMP/publish-out.txt") 2>&1'),
      "read-back gate output must enter the private diagnostics capture",
    );
    assert.doesNotMatch(workflow, /\/tmp\/publish-(?:out|payload)\.txt/);

    const criticalSteps = [
      "Assert the requested version matches package.json",
      "Pack and verify tarball",
      "Verify Forgejo credentials",
      "Check npmjs target version",
      "Check Forgejo target version",
      "Publish the verified tarball to npmjs (canonical)",
      "Publish the same tarball to Forgejo (mirror)",
    ];

    for (const name of criticalSteps) {
      const start = workflow.indexOf(`      - name: ${name}`);
      assert.notEqual(start, -1, `missing workflow step: ${name}`);
      const next = workflow.indexOf("\n      - name:", start + 1);
      const step = workflow.slice(start, next === -1 ? undefined : next);
      assert.match(
        step,
        /exec > >\(tee -a "\$RUNNER_TEMP\/publish-out\.txt"\) 2>&1/,
        `workflow step does not capture diagnostics: ${name}`,
      );
    }
  });
});
