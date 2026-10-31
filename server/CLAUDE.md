# Backend guide

Use Node.js 24.14+ (24.x). `config.ts` reads explicit environment configuration; default roots are App files only and default network binding is loopback.

Keep device authentication on APIs. LAN mode must not open local pairing-code generation or privileged request submission. Desktop IPC ownership checks are separate from HTTP authentication and both must remain intact.

History work runs in a worker. Delivery uses durable request IDs and an at-most-once ledger; a submitted transport is not proof of model receipt. Retain cursor/source ordering when merging history and partial output.

Legacy CLI, WebDAV, elevation and account queries are opt-in. The optional Agent SDK loads only when the legacy runner is started and is excluded from the default runtime distribution.
