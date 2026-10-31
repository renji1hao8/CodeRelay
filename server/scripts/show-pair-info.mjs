// 在电脑上运行:打印手机配对需要的全部信息
// 用法: node scripts/show-pair-info.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.REMOTE_CC_PORT ?? 8787);
const PASSWORD_FILE = path.join(process.env.REMOTE_CC_DATA_DIR || path.join(import.meta.dirname, "..", "data"), "pair-password.txt");

function localIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/**
 * 配对密码。
 *
 * 生成配对码的接口要它 —— 因为上了隧道之后 nginx 从 127.0.0.1 转发,
 * 后端再也分不清"本机"和"公网",光看来源地址挡不住人。
 *
 * 这个脚本跑在电脑上,所以读得到;公网上的人读不到,也就拿不到配对码。
 * 你不需要看见或输入它,这里只是把它带上。
 */
function readPairPassword() {
  try {
    return fs.readFileSync(PASSWORD_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const password = readPairPassword();
if (!password) {
  console.error(`读不到配对密码:${PASSWORD_FILE}`);
  console.error("后端启动时会自动生成它。先确认后端在跑(node src/index.ts),再重试。");
  process.exit(1);
}

let data;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/pair/start`, {
    method: "POST",
    headers: { "x-remote-cc-pair-password": password },
  });
  if (res.status === 403) {
    console.error("后端拒绝了配对码请求(403)—— 密码对不上。");
    console.error(`文件是 ${PASSWORD_FILE};它和后端正在用的那份不是一个。`);
    process.exit(1);
  }
  if (!res.ok) throw new Error(`后端返回 HTTP ${res.status}`);
  data = await res.json();
} catch (err) {
  console.error("拿不到配对码:", String(err));
  console.error(`请确认后端已在运行(node src/index.ts,端口 ${PORT})`);
  process.exit(1);
}

const publicUrl = data.publicUrl ?? "";
const line = "─".repeat(46);

console.log(line);
console.log("  手机配对信息");
console.log(line);
console.log(`  配对码      ${data.code}`);
console.log(`  有效期至    ${new Date(data.expiresAt).toLocaleTimeString("zh-CN")}`);
console.log("");

if (publicUrl) {
  console.log(`  电脑地址    ${publicUrl}`);
  console.log("              (公网隧道入口,走 TLS)");
} else {
  console.log("  ⚠ 没有配 REMOTE_CC_PUBLIC_URL —— 不知道该让你填哪个地址。");
  console.log("    在 deploy/config.ps1 里设上它,或者先手工填一个:");
  const others = localIPv4s();
  for (const o of others) console.log(`      http://${o.address}:${data.port}   (${o.name})`);
}

console.log(line);
console.log("  在 App 里填入上面的「电脑地址」和「配对码」即可。");
console.log(line);
