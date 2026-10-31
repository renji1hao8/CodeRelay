# 配置

源代码运行可在项目根 `.env` 中设置变量，通过 `npm start` 加载；Windows 启动脚本读取 `deploy/config.local.ps1`。两种方式不要给同一项设置冲突值。

| 环境变量 | 默认值与作用 |
| --- | --- |
| `REMOTE_CC_PORT` | `8787`，后端端口 |
| `REMOTE_CC_LISTEN_HOST` | `127.0.0.1`；可信 LAN 可显式设为 `0.0.0.0` |
| `REMOTE_CC_PUBLIC_URL` | 空，配对窗口显示的手机入口 |
| `REMOTE_CC_DATA_DIR` | `server/data`，数据库、设备记录和日志 |
| `REMOTE_CC_LIST_DIR` | 数据目录下 `list`，附件、图片和导出 |
| `REMOTE_CC_ROOTS` | 空；额外开放的目录，以分号分隔 |
| `REMOTE_CC_READONLY_ROOTS` | 空；只读目录 |
| `REMOTE_CC_FULL_ROOTS` | 空；允许文件 API 删除的目录，其余可写目录只允许添加 |
| `REMOTE_CC_HTTP_PROXY` | 空；也可使用 `HTTPS_PROXY` / `HTTP_PROXY` |
| `REMOTE_CC_PWSH` | 自动发现 PowerShell 7；可指定绝对路径 |
| `CODEX_HOME` / `CLAUDE_CONFIG_DIR` | 对应桌面配置目录，默认使用当前用户目录 |
| `REMOTE_CC_DESKTOP_BRIDGE_DIR` | 项目内置适配目录；仅开发调试时覆盖 |

可选功能默认关闭：`REMOTE_CC_ENABLE_ACCOUNTS`、`REMOTE_CC_ENABLE_WEBDAV`、`REMOTE_CC_ENABLE_ELEVATION`、`REMOTE_CC_ENABLE_LEGACY_CLI`，值为 `1` 时启用。

`deploy/config.example.ps1` 提供 Windows 变量示例。[集成目录](../integrations/README.md) 提供可选工作流；不要提交实际 `config.local.ps1`、`.env` 或账号文件。

## 账单时区

cc-switch 账单的“今日”和“本月”默认按电脑本地时区计算。需要固定时区时，可在本机配置中设置 `$env:REMOTE_CC_BILLING_UTC_OFFSET_MINUTES='480'`（UTC+8）；不设置则随电脑时区与夏令时变化。
