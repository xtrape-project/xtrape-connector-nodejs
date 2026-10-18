// Structured failure summarizer (server-ce review #803/#807 pattern): the raw step output must NEVER
// reach a PR comment — it bypasses the Actions log masking layer. Only lines
// matching known-safe failure shapes are kept, every kept line passes
// fail-closed redaction, and when nothing provably safe matches the comment
// says "see runner log" instead of guessing.
import { readFileSync, writeFileSync } from "node:fs";

const outputPath = process.env.PUBLISH_OUTPUT_PATH ?? "/tmp/publish-out.txt";
const payloadPath = process.env.PUBLISH_PAYLOAD_PATH ?? "/tmp/payload.json";

const raw = (() => {
  try {
    return readFileSync(outputPath, "utf8");
  } catch {
    return "";
  }
})();

const ANSI = /\x1b\[[0-9;]*m/g;
const STRUCTURED = [
  // npm error CODES only (E401/E403/E404/EPUBLISHCONFLICT/ENEEDAUTH...), never the message body.
  { match: /\bnpm (?:ERR!|error) code (E[A-Z0-9_]+)\b/, render: (m) => `npm error code ${m[1]}` },
  // HTTP status from a registry response line, without the URL (it may embed credentials).
  { match: /\bnpm (?:ERR!|error) (\d{3})\b/, render: (m) => `npm error HTTP ${m[1]}` },
  // Credential probe failure is authored by the workflow. Preserve only its
  // fixed label and three-digit status; curl response text and headers never
  // match this rule. HTTP 200 is intentionally not emitted by the workflow.
  {
    match: /^Forgejo auth probe failed: HTTP (\d{3})$/,
    render: (m) => `Forgejo auth probe HTTP ${m[1]}`,
  },
  // Our own failure assertions are authored text with no user data. Normal
  // state such as "does not have" or "identical tarball" is intentionally
  // excluded so successful earlier steps cannot suppress the fallback for an
  // unknown later failure.
  { match: /^(package\.json is .+ but the release asks for .+)$/, render: (m) => m[1].replace(/[^\w.@/ -]/g, "") },
  {
    match: /^(npmjs|Forgejo) already has .+ with different tarball integrity$/,
    render: (m) => `${m[1]} already has the target version with different tarball integrity`,
  },
  // Post-publish read-back gate: fixed shape authored by the workflow. The
  // package name, registry URL, and integrity values never enter this line.
  {
    match: /^read-back gate failed: (npmjs|Forgejo) (integrity mismatch|not readable within the per-registry window)$/,
    render: (m) => `read-back gate: ${m[1]} ${m[2]}`,
  },
  {
    match: /^\s*(FAIL)\s+([^\s]+\.(?:spec|test)\.[cm]?[jt]sx?)(?:\s.*)?$/,
    render: (m) => `${m[1]} ${m[2]}`,
  },
  {
    match: /^\s*(Test Files|Tests)\s+(.+\bfailed\b.*)$/,
    render: (m) => `${m[1]} ${m[2].replace(/[^0-9|()\sA-Za-z_-]/g, "")}`.trim(),
  },
  {
    match: /\b(Hook|Test) timed out in (\d+)ms\b/,
    render: (m) => `${m[1]} timed out in ${m[2]}ms`,
  },
  {
    match: /^(.+\.ts)\((\d+),(\d+)\): error (TS\d+):/,
    render: (m) => `${m[1]}(${m[2]},${m[3]}): error ${m[4]}`,
  },
];
const REDACT = [
  [/(authorization|bearer|token|secret|password|passwd|api[-_]?key|credential)(["'\s:=]+)\S+/gi, "$1$2[REDACTED]"],
  [/\bfile:[^\s"')]+/g, "file:[REDACTED]"],
  [/\bhttps?:\/\/[^\s"')]*@[^\s"')]+/g, "[REDACTED-URL]"],
  [/\b[A-Za-z0-9+/_-]{24,}\b/g, "[REDACTED]"],
];

const kept = [];
for (const line of raw.replace(ANSI, "").split("\n")) {
  const rule = STRUCTURED.find(({ match }) => match.test(line));
  if (!rule) continue;
  const match = line.match(rule.match);
  if (!match) continue;
  let safe = rule.render(match);
  for (const [re, sub] of REDACT) safe = safe.replace(re, sub);
  // Kept paths can contain backticks on POSIX filesystems. Strip them so a
  // test or source filename cannot terminate the Markdown code fence.
  safe = safe.replace(/`/g, "");
  kept.push(safe.slice(0, 300));
  if (kept.length >= 120) break;
}

const summary =
  kept.length > 0
    ? kept.join("\n")
    : "validation failed, but no line matched the safe summary allowlist — see the runner log.";
const body = `Publish failure summary (sha ${process.env.CI_SHA ?? "unknown"}, allowlisted + redacted; raw capture is not posted to the issue; full output remains in the protected Actions log):\n\`\`\`\n${summary.slice(0, 8000)}\n\`\`\``;
writeFileSync(payloadPath, JSON.stringify({ body }));
