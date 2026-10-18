# `@xtrape/connector` examples

Each example is a standalone TypeScript file you can run with `tsx`. They
build on each other in increasing complexity.

| File | What it shows |
| --- | --- |
| [`minimal-connector.ts`](./minimal-connector.ts) | The smallest viable Worker: just `XtrapeConnector` + `start()`. Useful to verify your registration token works. |
| [`health-config-action.ts`](./health-config-action.ts) | Adds health reporting, typed config items (one secret-bearing), and one `echo` action with a JSON schema. |
| [`prepare-handler.ts`](./prepare-handler.ts) | Demonstrates an action with a `prepare` handler that returns dynamic `initialPayload` and `currentState` for the action panel. |

## Running an example

```bash
# from xtrape-connector-nodejs root
pnpm install
pnpm build

cd examples
XTRAPE_SERVER_URL=http://localhost:8080 \
XTRAPE_REGISTRATION_TOKEN=xtrape_reg_... \
XTRAPE_TOKEN_FILE=./data/example-agent-token.txt \
npx tsx minimal-connector.ts
```

After the first start the registration token is no longer needed — the
Connector reuses the token file at subsequent runs.

> **Match versions across the matrix.** Pair `@xtrape/connector@^0.8.0` with
> `@xtrape/contracts@^0.7.6` (the current published contracts line) or use
> local checkouts for source-level integration. The legacy
> `@xtrape/capsule-*` packages are immutable compatibility identifiers — do
> not use them for new work.
