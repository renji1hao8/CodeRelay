# 第三方声明

本项目的 MIT 许可仅覆盖项目作者有权许可的代码与原创图标。依赖保留各自的许可与使用条件。

| 组件 | 来源及许可 |
| --- | --- |
| 桌面传输适配 | [KeeVeeG/codex-claude-desktop-bridge](https://github.com/KeeVeeG/codex-claude-desktop-bridge)，MIT，Copyright 2026 KeeVeeG；完整许可与快照哈希在 `server/vendor/desktop-bridge/` |
| Node.js（Windows 包） | [nodejs/node](https://github.com/nodejs/node)，运行时完整许可随包放在 `runtime/LICENSE.txt`；打包前校验官方二进制 SHA256 |
| React、React Native、Expo | MIT；具体版本和间接依赖以 `mobile/package-lock.json` 为准 |
| Fastify、node-pty、xterm.js、markdown-it | MIT；许可文件保留在分发依赖中 |
| markdown-it-cjk-friendly | MIT，来源见其 npm 包和 GitHub 仓库 |
| jimp-compact | MIT，仅用于生成项目自己的几何图标 |
| 可选 Claude Agent SDK | Anthropic 保留权利，使用受其 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 条件约束；不是本项目 MIT 代码，也不包含在默认 Windows 生产依赖包中 |

Windows 后端包会保留 npm 生产依赖中的 LICENSE/NOTICE 文件。桌面应用、模型服务、cc-switch、代理及隧道工具由用户另行安装，不随本项目重新许可。

Android 生产依赖的许可文本生成在 `mobile/assets/third-party-notices.txt`，随正式 APK 放在 `assets/third-party-notices.txt`，并提供同一 Release 下的文本副本。
