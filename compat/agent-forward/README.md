# @xtrape/agent — forwarding package

**This package was renamed to [`@xtrape/connector`](https://www.npmjs.com/package/@xtrape/connector)**
per the Xtrape 0.8.0 concept freeze (`Agent` is no longer a platform top-level
concept; the connection/runtime SDK concept is **Connector** — agent-nodejs#75).

This final release is a thin forwarder: it re-exports `@xtrape/connector`
unchanged, including the `@deprecated` compatibility aliases `XtrapeAgent` /
`XtrapeAgentOptions`. It will receive no further updates and is scheduled for
retirement after one minor-release window.

Migrate:

```bash
npm remove @xtrape/agent
npm install @xtrape/connector
```

```ts
// before
import { XtrapeAgent } from "@xtrape/agent";
// after
import { XtrapeConnector } from "@xtrape/connector";
```

Wire protocol, `serveCeService`, endpoints, and token semantics are unchanged —
this is a naming-plane rename only. Published `0.7.x` versions of
`@xtrape/agent` remain immutable.
