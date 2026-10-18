# AGENTS.md

## Repository Role

This repository owns the Node.js Connector SDK — the embedded SDK a Service (Worker runtime) uses to register with and serve the Xtrape control plane.

The canonical package is `@xtrape/connector` and the canonical entry class is
`XtrapeConnector` (formerly `@xtrape/agent` / `XtrapeAgent`; renamed per the
0.8.0 concept freeze, agent-nodejs#75). `XtrapeAgent` / `XtrapeAgentOptions`
remain only as `@deprecated` compatibility aliases. New API examples use
`XtrapeConnector` and Worker terminology.

The SDK is embedded inside a Service (Worker runtime) and connects to the Xtrape control plane (`xtrape-platform-ce`, the current physical package of Xtrape Platform CE; formerly `xtrape-server-ce`). Panel CE is a Web UI Device over that control plane — it is not the control plane the SDK connects to.

Primary responsibilities:

- Connector registration
- agent token persistence
- heartbeat loop
- Worker Runtime Report submission
- action registration
- action prepare/execute handling
- command polling
- command result reporting
- retry classification
- typed errors
- structured logging hooks
- SDK examples

Canonical architecture:

```text
xtrape-platform-ce (control plane) <----long-poll---- Service (Worker runtime)
                                                    embeds @xtrape/connector
```

## Non-goals

This repository is not a transport gateway (`Gateway` is a retired top-level concept — concepts/09).

Do not add:

- sidecar/external Connector local Worker adapter implementation
- Go runtime logic
- Docker base-image runtime logic
- CE backend/admin UI logic
- database persistence for the control plane (platform-ce)
- marketplace logic
- demo-only workflow assumptions
- public documentation that belongs in the site repository

This package is an SDK for Node.js services, not a node-level operations host.

## Embedded Connector vs Sidecar / External Connector

(Formerly "Embedded Agent" / "External Agent" modes — renamed per the 0.8.0
concept freeze; Agent Token credential semantics are unchanged.)

### Embedded Connector Mode

```text
xtrape-platform-ce (control plane) <----long-poll---- Service (Worker runtime)
                                                    embeds @xtrape/connector
```

This repository owns this mode.

### Sidecar / External Connector Mode

```text
xtrape-platform-ce (control plane) <----long-poll---- External adapter <----local contract---- Worker
```

This repository does not own sidecar or external Connector implementations.
(`Gateway` is a retired top-level concept — concepts/09; any such routing
belongs to Platform modules, not to a standalone Gateway role.)

## Version / Release Train Rules

Xtrape uses matching minor versions across public packages.

During development:
- Before starting implementation, run `git fetch --all --prune` and check whether the current branch is behind its upstream. Pull or rebase the latest upstream code before editing, unless local uncommitted work must first be stashed or committed.
- Do not assume unpublished npm versions exist.
- Do not set dependencies to versions such as `^0.3.0` before that version is published.
- Use Forgejo branch dependencies, local workspace linking, or npm prerelease packages when needed.
- Release candidates should use `0.3.0-rc.x` with the `next` npm dist-tag.
- Final releases should use semver versions with the `latest` npm dist-tag.

Recommended release order:

```text
1. xtrape-contracts-nodejs (@xtrape/contracts)
2. xtrape-connector-nodejs (@xtrape/connector)
3. xtrape-platform-ce
4. xtrape-panel-ce
5. xtrape-demo
6. xtrape-site
```


## Dependency Policy

Keep dependencies lightweight.

Allowed when justified:

- HTTP client or fetch wrapper if needed
- retry/backoff utility if small and stable
- contract package
- logging-independent record types

Avoid:

- heavy frameworks
- server frameworks
- database libraries
- UI libraries
- Xtrape Panel-specific backend packages
- demo-only dependencies

The SDK should remain easy to embed inside user services.

## Development Commands

Common commands:

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Before marking work complete, run the available checks in `package.json`.

## Testing Expectations

Tests should cover:

- registration success and failure
- registration token failure classification
- agent auth failure classification
- retryable network failures
- non-retryable 4xx failures
- heartbeat loop behavior
- Worker Runtime Report payloads
- command polling
- command result reporting
- structured failure results
- typed error exports

## Documentation Rules

When changing SDK behavior, update:

- README examples
- typed error docs
- logging docs
- release notes or site docs if user-visible
- compatibility matrix if version-sensitive

Do not document features that require unpublished CE/contract behavior unless clearly marked.

## AI Safety Rules

When working in this repository:

- Do not implement transport-gateway behavior here (retired concept).
- Do not make CE depend on this package.
- Do not change contracts by copying types locally; update `contracts-node` first.
- Do not swallow typed errors into generic errors.
- Do not retry registration/auth failures that require operator action.
- Do not hardcode demo service codes into SDK logic.
- Do not add global state that prevents multiple connector instances in one process unless explicitly required.

## PR Checklist

- [ ] The change belongs in the Embedded Connector SDK.
- [ ] Contracts dependency is valid for the current release stage.
- [ ] Typecheck/build passes.
- [ ] Tests or examples cover behavior changes.
- [ ] README/docs are updated if public behavior changed.
- [ ] Retry classification is explicit.
- [ ] Typed errors remain stable.
- [ ] No transport-gateway runtime behavior was added (Gateway is a retired concept).
