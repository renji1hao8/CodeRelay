# RemoteCC

在 Android 手机上继续电脑里的 Claude Code 和 Codex 桌面会话。

[下载 1.0.0](https://github.com/renji1hao8/RemoteCC/releases/tag/v1.0.0) · [首次安装教程](docs/QUICKSTART.zh-CN.md) · [反馈问题](https://github.com/renji1hao8/RemoteCC/issues)

RemoteCC 由 Android App 和 Windows 后端组成。消息投递到电脑原会话，手机与电脑共用同一份历史。桌面同步模式不会另外启动 CLI 续接会话。

## 安装

从 [1.0.0 Releases](https://github.com/renji1hao8/RemoteCC/releases/tag/v1.0.0) 下载：

| 文件 | 用途 |
| --- | --- |
| [RemoteCC-1.0.0-Windows.zip](https://github.com/renji1hao8/RemoteCC/releases/download/v1.0.0/RemoteCC-1.0.0-Windows.zip) | 电脑后端，附运行时与生产依赖 |
| [RemoteCC-1.0.0-Android.apk](https://github.com/renji1hao8/RemoteCC/releases/download/v1.0.0/RemoteCC-1.0.0-Android.apk) | 手机安装包 |
| [RemoteCC-1.0.0-Source.zip](https://github.com/renji1hao8/RemoteCC/releases/download/v1.0.0/RemoteCC-1.0.0-Source.zip) | 脱敏源码，供修改与自行构建 |
| `RemoteCC-1.0.0-Android-Notices.txt` | Android 包内第三方许可的文本副本 |
| `SHA256SUMS.txt` | 下载校验值 |

1. 在 Windows 11 电脑上解压后端包。首次运行 `setup.cmd`，选择连接方式和允许手机浏览的项目目录。
2. 按 [快速开始](docs/QUICKSTART.zh-CN.md) 安装并授权桌面桥接插件，打开要继续的桌面会话。
3. 运行 `desktop-control.cmd` 创建桌面快捷方式。需要审批、停止和历史唤醒时，用这些快捷方式启动对应桌面应用。
4. 双击 `start.cmd`。窗口会显示电脑地址与五分钟内有效的配对码。
5. 手机安装 APK，填写地址和配对码。

完整步骤及常见错误见 [首次安装教程](docs/QUICKSTART.zh-CN.md)。源码安装需要 Node.js 24.14+（24.x）；命令页需要 PowerShell 7。桌面应用的账号、网络和模型供应商需先在电脑上配置好。

## 可以做什么

- 读取并继续 Claude/Codex 原会话，切换时保留列表、草稿和待发附件。
- 在桌面控制连接开启后处理普通工具审批、中断当前轮；查看并停止 Claude 指定后台任务。
- 打开可核验归属的 Claude 历史会话。已有其他写入进程时拒绝重复续接。
- 发送图片和文件；图片支持四档压缩预览，历史以缩略图展示。
- 使用持续的 PowerShell 终端，保留变量与目录，支持 Tab、方向键、交互输入和 Ctrl+C。
- 浏览明确开放的文件目录；默认仅开放 App 数据目录。
- 按需启用 cc-switch 额度、只读 WebDAV、管理员执行器和归档参考集成。

手机能调用电脑账户权限下的终端。只给自己信任的设备配对，不要把后端端口直接转发到公网。

## 连接方式

| 场景 | 配置 |
| --- | --- |
| 同一可信 Wi-Fi | 向导选择 LAN，手机填 `http://电脑局域网地址:8787`；仅用于可信网络 |
| 外网、移动网络 | 使用 HTTPS 反向代理或私有隧道；后端保留环回监听 |
| 自签证书 | 作为本机自定义构建选项；公开 APK 使用系统信任根 |

[配置说明](docs/CONFIGURATION.md) · [可选集成](integrations/README.md) · [安全边界](SECURITY.md)

没有域名但有公网 IP 时，可使用自动续期的 [Let’s Encrypt IP 证书](integrations/network/IP-CERTIFICATE.md)，公开 APK 使用系统证书链验证。

## 开发

```powershell
npx --yes pnpm@12.11.2 install --frozen-lockfile
npm --prefix mobile ci
npm test
npm run typecheck
npm --prefix mobile run typecheck
```

[架构](docs/ARCHITECTURE.md) · [Android 构建](docs/BUILD.md) · [1.0.0 发布流程](docs/RELEASING.md) · [更新记录](CHANGELOG.md)

## 支持范围

1.0.0 面向 Windows 11 电脑和 Android 手机。macOS、Linux 后端及 iOS 尚未验收。原生桌面接口随应用升级可能变化；兼容性记录与实测范围见 [兼容性](docs/COMPATIBILITY.md)。

原项目中的个人网络入口、目录、证书、诊断记录和运行数据不随公开包分发。个人工作流的通用示例放在 `integrations/`，默认关闭。

## 许可

本项目代码使用 MIT 许可，见 [LICENSE](LICENSE)。桌面传输适配保留 [Codex–Claude Desktop Bridge](https://github.com/KeeVeeG/codex-claude-desktop-bridge) 的 MIT 许可和来源记录。依赖与可选 SDK 的许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。
