# Security Policy

`@xtrape/connector` (formerly `@xtrape/agent`) runs inside services and handles Agent bearer tokens. Treat all token and action behavior as security-sensitive.

## Reporting a vulnerability

Report suspected vulnerabilities **privately** — never in a public issue, and
never with exploit details, credentials, tokens, or secret-bearing logs. Redact
secrets, personal data, and internal addresses from any report.

Channels, in order (the canonical policy's order):

1. **`security@xtrape.com`** — the project security role address and the
   primary channel.
2. The **private vulnerability-reporting mechanism of the public repository
   host** for the affected repository, when the host offers one and it is
   enabled. The canonical public source of every Xtrape component is the
   `xtrape-project` organisation on `forgejo.xtrape.com`; mirrors on other
   platforms are copies, not intake points.

If neither is available, open only a minimal public request for a private
contact — with no exploit details.

Operational targets (not SLAs): acknowledgement within 3 business days,
initial triage and severity assessment within 7 calendar days. Coordinated
disclosure is preferred, with a stated safe-harbor intent for good-faith
research.

The canonical policy (channels of record, scope, response targets,
coordinated disclosure, and safe-harbor intent) is published with the Xtrape
concept baseline: <https://xtrape.com/governance> and
<https://forgejo.xtrape.com/xtrape-project/xtrape-site/src/branch/main/SECURITY.md>.

## Token handling

- Registration Tokens are bootstrap credentials and should be short-lived and single-use.
- Agent Tokens are long-lived bearer credentials; store them in a private token file or secret manager.
- Never commit token files.
- If an Agent Token leaks, revoke the connector in Panel and register a new connector.

## Action safety

Actions are operator-triggered remote operations. SDK users should:

- mark risky actions with `dangerLevel` and `requiresConfirmation`;
- validate payloads inside action handlers;
- avoid returning secrets in action results;
- make destructive handlers explicit and audited;
- use timeouts for long-running operations.

## Secret handling

Do not include raw passwords, API keys, cookies, OTP codes, browser storage, or session files in health reports, config reports, action prepare data, action results, or logs. Use redacted previews and secret references instead.
