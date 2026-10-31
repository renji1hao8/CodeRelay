# Development conventions

- Keep workstation configuration, runtime data, credentials, certificates and signing files out of source control. Use `.local/` or documented local configuration files.
- Desktop sync targets the verified original session. Do not add an implicit CLI fallback, invent caller identities, bypass native approval, or retry uncertain writes.
- Preserve directory, session, task and request identity checks when changing adapters.
- Shared protocol source lives in `packages/shared/src`; run `node mobile/scripts/sync-protocol.mjs` after changing it.
- Use one root keyboard avoidance provider. Keep Claude/Codex presentation shared.
- Run `npm test`, both typechecks, and the public-source audit for relevant changes. Distinguish fixture checks, real desktop reads and actual phone validation.
- Public releases use clean exports, system TLS roots and a stable private signing key. Never make the historical private repository public as a substitute for an export.
