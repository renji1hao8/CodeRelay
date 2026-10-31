// 在电脑上运行:打印只读 WebDAV 的挂载地址与凭据
// 用法: node scripts/show-webdav-info.mjs
import fs from "node:fs";
import path from "node:path";

const PREFIX = "/dav";
const USER = "remotecc";

const dataDir = path.join(import.meta.dirname, "..", "data");
const passwordFile = path.join(dataDir, "webdav-password.txt");

/**
 * 公网入口地址。
 *
 * 后端是从环境变量读的(由 deploy/bootstrap.ps1 注入),而这个脚本在另一个进程里,
 * 拿不到那份环境。所以这里退回读 deploy/config.ps1 里的 $PublicUrl —— 那是唯一真相源。
 */
function publicUrl() {
  if (process.env.REMOTE_CC_PUBLIC_URL) return process.env.REMOTE_CC_PUBLIC_URL.replace(/\/+$/, "");
  try {
    const cfg = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "deploy", "config.ps1"),
      "utf8",
    );
    const m = /^\$PublicUrl\s*=\s*"([^"]+)"/m.exec(cfg);
    if (m?.[1]) return m[1].replace(/\/+$/, "");
  } catch {
    /* 读不到就算了,下面会提示 */
  }
  return "";
}

const password = (() => {
  try {
    return fs.readFileSync(passwordFile, "utf8").trim();
  } catch {
    return "";
  }
})();

const base = publicUrl();
const line = "─".repeat(52);

console.log(line);
console.log("  只读 WebDAV(整机挂载)");
console.log(line);

if (base) {
  console.log(`  地址        ${base}${PREFIX}/`);
} else {
  console.log("  ⚠ 没读到公网地址 —— 在 deploy/config.ps1 里设 $PublicUrl");
  console.log(`    本地调试可用 http://127.0.0.1:8787${PREFIX}/`);
}
console.log(`  用户名      ${USER}`);
console.log(`  密码        ${password || "(还没生成 —— 后端启动时会自动建)"}`);
console.log("");
console.log("  只读:能浏览、下载、看图片视频,不能改任何东西。");
console.log("  想写文件请走 App 的文件页。");
console.log("");

if (!base) {
  console.log(line);
  process.exit(0);
}

console.log("  手机上怎么加:");
console.log("    Cx 文件管理器 → 网络 → 新建 → WebDAV");
console.log("    地址填上面的,用户名/密码照抄");
console.log("");

// 这段提示随公网入口而变 —— 别写死。2026-09-19 换成域名之前,
// 入口是 https://<IP>:30178 走自签证书,那时"文件管理器会提示证书不可信"是对的;
// 换成域名(标准 443 + Let's Encrypt)之后就不成立了,再留着会把人带沟里。
const isSelfSigned = /^https:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(base);
if (isSelfSigned) {
  console.log("  ⚠️ 当前入口是IP + 自签证书,第三方文件管理器会提示证书不可信。");
  console.log("     大多数(如 Cx / Solid Explorer)有「允许自签名/不受信任证书」的开关,打开即可。");
} else {
  console.log("  ✅ 入口走的是 Let's Encrypt 真证书,文件管理器不会报证书问题,直接填就行。");
}
console.log("");
console.log("  Windows 上怎么挂:");
console.log(`    net use Z: "${base}${PREFIX}/" /user:${USER} <密码>`);
if (isSelfSigned) {
  console.log("    Windows 自带客户端不接受自签证书,要么把 deploy/remotecc-server.crt");
  console.log("    导进「受信任的根证书颁发机构」,要么用第三方客户端(如 RaiDrive)。");
}
console.log(line);

// ---------------------------------------------------------------------------
// 上面那套是**后端自己**提供的 WebDAV —— 把电脑上的文件(所有盘符)只读地摊出来。
//
// 下面这套是**服务器(VPS)上的共享目录**,由 rclone 提供,和电脑上的 `Z:` 是同一份数据
// (电脑上 `Z:` 映射的就是 VPS 的 /srv/share)。两套彼此独立,别混 —— 凭据都不一样。
// 装机脚本见 deploy/vps/install-webdav.sh。
//
// 密码存在 VPS 的 /etc/remotecc/webdav.env 里,而这个脚本在电脑上跑、读不到它,
// 所以只印地址和取密码的命令。
// ---------------------------------------------------------------------------
if (base) {
  console.log("");
  console.log("  服务器共享(另一套凭据,不是上面那组用户名密码)");
  console.log(line);
  console.log(`  只读      ${base}/vps-ro/`);
  console.log(`  可读写    ${base}/vps-rw/`);
  console.log("  取密码    ssh remotecc@<VPS> 'sudo cat /etc/remotecc/webdav.env'");
  console.log("            两个端点同一组账号密码,权限差别落在 URL 前缀上 ——");
  console.log("            走 /vps-ro/ 就绝对写不进去(服务端 rclone 带着 --read-only)。");
  console.log(line);
}
