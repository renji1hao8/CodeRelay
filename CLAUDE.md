# Project guide

Read [AGENTS.md](AGENTS.md), [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Windows backend: `server/src`. Android UI: `mobile/src`. Shared messages: `packages/shared/src`. Optional integrations: `integrations/`. Machine-specific material belongs in ignored local files.

Do not operate real user chats as a test. Pure fixtures and isolated backends are the default validation; report live-device checks separately.
