# 1.0.1 依赖审计记录

正式发行前已将手机框架升级至 Expo 58.0.22、React Native 0.88.1、React 19.3.0，并按 Expo 版本表同步图片、文件、键盘、WebView 和动画组件。

| 范围 | 结果 |
| --- | --- |
| 手机端完整依赖树（含构建依赖） | npm audit：0 项已知漏洞 |
| 后端工作区完整依赖（含开发与可选旧 CLI SDK） | pnpm audit：0 项已知漏洞 |
| Windows 后端生产依赖 | npm audit：0 项已知漏洞 |

修复包括 Fastify 5.12.7、markdown-it 15.0.3、shell-quote、node-forge、source-map-js，以及 Expo 58 使用的新版 zod/deepmerge。

可选 SDK 更新至 0.3.314，其依赖的 MCP SDK、Hono、qs、zod 和 URI 解析库也随锁文件更新到修复版本。

Expo 58 的部分构建依赖仍限制使用旧 glob/minimatch，因此在 `mobile/package.json` 中显式固定 `glob 14.0.2` 和 `minimatch 11.0.1`。这些覆盖使用真正修复的版本，没有忽略或屏蔽审计告警。升级后通过 Expo 配置/预构建、Metro 打包、完整 Android 原生构建、回归与类型检查验证兼容性。

审计结果对应本次锁文件，是已知漏洞数据库的快照。后续更改依赖时，重新安装并执行审计及构建验证；不要只修改覆盖版本而跳过兼容性检查。

```powershell
npm --prefix mobile audit --registry=https://registry.npmjs.org
npm audit --prefix dist/coderelay-1.0.1/windows/server --omit=dev --registry=https://registry.npmjs.org
```

可选 Claude Agent SDK 不包含在默认 Windows 生产依赖中；需要该旧 CLI 功能时，另行安装并遵守其使用条件。

参考：[Expo 58 升级](https://expo.dev/blog/how-to-upgrade-to-sdk-58)、[glob 告警](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)、[minimatch 告警](https://github.com/advisories/GHSA-g3hv-75wg-m249)。
