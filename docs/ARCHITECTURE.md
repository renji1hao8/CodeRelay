# 架构

Android App 通过设备鉴权的 HTTP/WebSocket 连接 Windows 后端。后端只读本机历史，并通过桌面原生传输向原会话投递。

```text
Android App
  ├─ 会话 / 附件 / 文件 / 终端
  └─ 配对设备 token
         │ HTTP / WebSocket
Windows 后端
  ├─ desktop：会话身份、投递账本、原生控制
  ├─ history worker：Claude 索引 / Codex rollout 分页
  ├─ terminal：每台设备独立的 ConPTY / pwsh
  └─ 可选 accounts / WebDAV / elevation / legacy CLI
         │ 本机已授权的管道或环回控制连接
Claude Code / Codex Desktop 原会话
```

`server/src/desktop/delivery.ts` 先记录设备、目标及消息摘要，再投递一次。重复请求 ID 不再次写入。未知结果由历史核对确认，不自动切换传输或重发。

Codex 历史按 rollout 字节位置排序，稳定 item ID 让增量与落盘消息替换衔接。`packages/shared/src/user-content.ts` 只处理展示，不修改发往桌面的原文。手机确认消息时同时比较正文与附件。

桌面控制连接校验端口所有者、应用安装路径与 preload 能力。操作重新核对当前会话、轮次、审批或任务 ID。历史唤醒核对原始记录与原生恢复身份，拒绝共享历史的其他 fork。

手机项目使用独立 npm 依赖；后端和共享协议使用 pnpm 工作区。修改共享协议后运行 `node mobile/scripts/sync-protocol.mjs`。键盘避让统一在 App 根部处理。
