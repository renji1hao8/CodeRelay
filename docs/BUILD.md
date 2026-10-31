# 构建

后端要求 Node.js 24.14+（24.x）。开发环境需要 pnpm 12.11.2。Android 构建另需 JDK 21、Android SDK 和项目所要求的 SDK/NDK 组件；不要求安装本机专用编译链。

1.0.1 使用 Expo 58 / React Native 0.88.1，Android compile SDK 37、Build Tools 37.0.0、NDK 27.1.12297006、Gradle 9.4.1；最低 Android API 24，target SDK 36。构建脚本保留模板要求的 Gradle 版本，启用镜像时只更换下载源。

```powershell
npx --yes pnpm@12.11.2 install --frozen-lockfile
npm --prefix mobile ci
node mobile/scripts/sync-protocol.mjs
npm test
npm run typecheck
npm --prefix mobile run typecheck
```

设置 `JAVA_HOME` 和 `ANDROID_HOME`，或给构建脚本传 `-JavaHome` / `-AndroidSdk`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-ascii.ps1 -PublicRelease -SkipVersionBump
```

公开构建从源码重新生成原生工程，在短英文路径编译，默认使用官方依赖源、系统 TLS 信任根和正式签名。不会复用旧原生工程中的证书、图标或调试签名。

原生编译使用文件路径映射，将当前用户目录、Gradle 缓存和构建源码路径替换为通用路径。发布前仍需扫描 APK 中的原生库；只扫描文本源码无法发现编译器嵌入的本机路径。

第一次本机构建会在 `.local/release/` 创建签名文件与密码文件。备份它们，后续更新必须沿用同一签名；不要把该目录上传 GitHub。CI 从 Secret 注入签名环境变量，见 [发布](RELEASING.md)。

`-SkipVersionBump` 用于已手动确定版本的正式构建；不传时会递增 Android versionCode。`-KeepStaging` 保留临时目录便于核验。`-StageBase` 可指定有写权限的短路径。

如需镜像或自签 CA，请参考 [构建适配](../integrations/build/README.md)。应用源码中的生成文件和编译目录不进入公开源码包。
