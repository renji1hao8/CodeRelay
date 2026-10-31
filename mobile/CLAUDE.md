# Mobile guide

Mobile dependencies use npm independently from the backend workspace. Claude/Codex share `DesktopSessionsScreen` and `DesktopChatScreen`.

Use `theme.ts` and shared UI components. Keyboard avoidance belongs at the App root; do not add page-specific keyboard height padding. Preserve safe-area handling and verify IME behaviour on a real phone when possible.

User content presentation is generated from `packages/shared/src/user-content.ts`. Preserve literal code/unknown wrappers; never change wire text merely to clean up display. Receipt confirmation must account for both text and attachment paths.

Images use per-image compression preview; failed uploads retain the message draft. Tool groups distinguish current pending results from incomplete historical records. Do not mark a tool running merely because a paginated result is absent.
