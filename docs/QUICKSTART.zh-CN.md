# 第一次安装

准备一台已能正常使用 Claude Code 或 Codex 的 Windows 11 电脑，以及一部 Android 手机。电脑需要保持开机。

## 1. 下载并解压

从 [1.0.1 下载页](https://github.com/renji1hao8/CodeRelay/releases/tag/v1.0.1) 下载 Windows ZIP 和 Android APK。把 Windows ZIP 解压到一个固定目录，例如 `C:\Apps\CodeRelay`。请先解压，再运行文件，不要直接在压缩包预览窗口内启动。

Windows 包附后端运行时与依赖。若你下载的是 Source ZIP，先安装 Node.js 24.14+（24.x），再双击 `setup.cmd` 安装依赖。

## 2. 准备桌面会话

安装并正常登录电脑上的 Claude/Codex 桌面应用，让目标会话先在电脑上工作。

按 [桥接插件上游 Windows 安装说明](https://github.com/KeeVeeG/codex-claude-desktop-bridge#installation) 在相应桌面端安装、启用并授权 **Codex–Claude Desktop Bridge**。这一步让后端找到真实桌面上下文；只复制本项目不会替桌面应用注册 MCP。

已安装 Git、Node.js 和对应产品的管理 CLI 时，在 PowerShell 中依次运行：

```powershell
git clone https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
Set-Location codex-claude-desktop-bridge
node scripts/install.mjs
```

只使用一个产品，可给最后一条命令加 `--codex` 或 `--claude`。这些 CLI 在此用于注册插件，不启动另一个模型会话。上游安装器会备份配置，并为 Claude 添加一条明确的桥接工具授权；请阅读其说明。安装后在桌面应用刷新插件/重新打开会话，按正常提示完成授权。在 Codex Desktop 的任务中首次安装或调用一次桥接工具，有助于注册当前桌面宿主。

若提示 `codex` 或 `claude` 找不到，需先按对应产品官方说明安装其管理 CLI；若插件被拒绝，检查桌面应用的插件设置和权限。不要通过修改全局自动批准来绕过它。

如果插件提示找不到 Node，可以安装 Node.js 24，或使用下一步生成的手机控制快捷方式启动桌面应用，它会继承包内运行时的 PATH。

双击 `desktop-control.cmd`，它会创建“claude 手机控制”和“codex 手机控制”快捷方式。保存当前工作并完全退出对应桌面应用，然后用快捷方式重开一次。脚本不会替你关闭正在运行的任务。

Claude 手机续接需要这个控制连接，包括向空闲会话发送消息。它通过桌面正常输入接口继续原会话，不使用跨会话收件箱唤醒智能体。连接未开启时，历史仍可读取，发送会提示错误。

## 3. 配置连接

双击 `setup.cmd`。首次会问：

- **同一可信 Wi-Fi**：输入 `1`。电脑地址可以先留空，启动时会列出局域网地址。
- **隧道或 HTTPS 反向代理**：输入 `2`。电脑地址填写你的 HTTPS 或私有网络入口。参考 [网络集成](../integrations/network/README.md)。
- **项目文件夹**：填写允许手机浏览的绝对路径；多个目录用分号隔开。留空时只有 App 自己的文件目录可见。

配置保存在 `deploy/config.local.ps1`，以后可用记事本修改。它只留在你的电脑上。

## 4. 启动与配对

双击 `start.cmd`，等待显示版本、地址和配对码。后台启动后可以关闭这个窗口。

同一 Wi-Fi 模式下，选择电脑 Wi-Fi 网卡的地址，手机填 `http://该地址:8787`。不要填 `127.0.0.1`，那指的是手机自己。Windows 防火墙提示时，只允许你信任的专用网络。

把 APK 传到手机安装，打开 CodeRelay，填写电脑地址、设备名称及六位配对码。配对码五分钟内有效；过期后在电脑上双击 `pair.cmd` 重新生成。

## 5. 使用

进入 Claude 或 Codex 列表，打开目标会话。手机消息会投递到电脑原会话。未打开的 Claude 历史可点“打开并继续”；若提示占用或工作目录信任，需要先在电脑处理。

输入框左侧“＋”可添加图片或文件。选图后比较四档压缩预览，再添加到消息；缩略图旁可删除附件。

命令页需要 PowerShell 7。它新建一个持续的 pwsh，会保留变量和目录；不会接管你已打开的终端窗口。

## 连不上时

| 现象 | 先检查 |
| --- | --- |
| 手机连接失败 | 电脑是否运行 `start.cmd`；地址是否为 Wi-Fi 网卡地址；防火墙是否允许专用网络 |
| 后端能连，桌面会话为空 | 桌面应用、目标会话和桥接插件是否已启用；在电脑会话中完成插件授权 |
| 审批或停止不可用 | 是否用手机控制快捷方式重开了桌面应用 |
| Claude 能读历史但无法发送 | 完全退出 Claude，再用“claude 手机控制”快捷方式打开；旧消息先核实，避免重复发送 |
| 找不到 PowerShell | 安装 PowerShell 7，再重启后端；聊天功能不要求启用命令页 |
| 图片或文件无法下载 | 文件是否在配置允许的目录内，或电脑原文件是否已被移动 |
| 启动后退出 | 双击 `doctor.cmd`，检查 `server/data/logs/server.err.log`；公开求助前清理个人信息 |

## 从旧测试包迁移

从正式签名的 RemoteCC 1.0.0 升级到 CodeRelay 1.0.1，可直接覆盖安装，已有配对信息继续保留。

电脑端覆盖升级时，先结束旧后端和它的终端任务，再将 Windows ZIP 解压到原安装目录，保留 `server/data/` 与 `deploy/config.local.ps1`。如果换目录，先备份并迁移这两项；不要同时运行两套后端。

1.0.1 公开 APK 使用独立的正式签名。如果旧测试包签名不同，Android 会拒绝覆盖安装。先保存手机尚未发送的草稿，卸载旧测试包，再安装公开 APK 并重新配对。电脑上的会话历史不会因卸载手机 App 被删除。
