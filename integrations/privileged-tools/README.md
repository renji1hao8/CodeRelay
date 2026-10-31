# 进阶工具

这些功能默认关闭，在 `deploy/config.local.ps1` 中逐项启用。

- **只读 WebDAV**：`$EnableWebDav=$true`。重启后端后运行 `server/scripts/show-webdav-info.mjs` 取得本机生成的凭据。不要公开该输出。
- **管理员执行器**：`$EnableElevation=$true`，再按需运行 `deploy/install-elevated-executor.ps1`。它需要 UAC，执行范围见脚本白名单。默认关闭自由命令；手机批准只针对当前请求。
- **旧 CLI 兼容接口**：`$EnableLegacyCli=$true`。Claude Agent SDK 是额外依赖，按其自身使用条件安装；默认 Windows 运行包不含 SDK。Codex CLI 也需另装。现有桌面占用检查仍会阻止冲突写入。

普通桌面会话审批、中断与后台任务控制不需要管理员执行器。请勿为了使用桌面同步而启用旧 CLI。
