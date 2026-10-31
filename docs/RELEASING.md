# 发布 1.0.1

公开仓库必须从 `npm run release:source` 的干净导出建立。不要公开开发时的私人仓库；忽略规则不能删除旧提交中的个人配置。

## 本机准备

1. 按 [构建说明](BUILD.md) 安装依赖。运行 `npm test`、后端和手机两端类型检查，以及 `npm run audit:public`；重新检查 [依赖审计记录](DEPENDENCY-AUDIT.md)，不要把源码脱敏扫描当成依赖漏洞扫描。
2. 运行 `node scripts/package-windows.mjs`。它在 Windows x64 打包生产依赖，从官方 Node 发布清单核验当前 Node 二进制，并带上完整运行时许可。产物中不包含原 `server/data`、配置、账号或可选 Claude SDK。
3. 按构建说明生成正式签名 APK。签名文件只存本机 `.local/release/`，备份到自己的安全位置；丢失后无法覆盖安装更新。
4. 运行 `node scripts/assemble-release.mjs`。生成源码、Windows ZIP、APK 和 SHA256 清单。输出目录已存在时脚本拒绝覆盖，请先移走旧生成目录。
5. 在新建、未配置的目录解压 Windows 包，运行向导、启动、配对，并在手机确认会话、输入法和图片。真实桌面审批和历史唤醒必须单独验收；单元测试不能代替这些检查。

## 建立公开仓库

只进入生成的 `dist/coderelay-1.0.1/source/` 初始化新 Git 仓库。首次提交必须包含 `.public-source.json`，它标识无私人历史的起点。运行 `node scripts/guard-release.mjs` 验证后，再关联新建的 GitHub 仓库。不要把旧仓库的分支、标签或 `.git` 复制进去。

将发行文件上传为 `v1.0.1` 的草稿 Release，检查文件名、校验值、许可、教程链接与实测范围后再发布。源码包无 `.git`；若另行分享初始化的源码目录，请检查 Git 作者邮箱是否愿意公开。

## GitHub Actions

CI 在 Windows 上运行确定性测试、类型检查和脱敏扫描。手动的 `release` 工作流只允许干净仓库，构建产物供下载核验，不自动公开 Release。

在仓库 Secrets 中配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_STORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。签名不齐时流程失败，不会临时生成一个新签名。用于 GitHub 的密钥必须与本机发行包相同。

自动扫描只检测已知格式。发行前仍需人工检查默认地址、账号适配、文件白名单、第三方许可与导出清单。发现敏感值时重新导出，不把删除敏感值的后续提交当成历史已清理。
