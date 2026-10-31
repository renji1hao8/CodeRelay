import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { listLive } from "./cc/registry.ts";
import { probePort } from "./probe.ts";

/**
 * 诊断包。
 *
 * ## 它存在的理由
 *
 * 这个项目的工作场景是**人不在电脑前**:手机经公网隧道连到电脑上的后端。一旦
 * "会话起不来",手机这侧拿到的只有一条报错 —— 而真正的线索(boot.log、server.err.log、
 * 谁没在监听)全躺在电脑上。没有这个包,就只能等人回到电脑前。
 *
 * ## 为什么是一份纯文本,而不是 zip
 *
 * 计划里原本写的是 zip。改成纯文本是**故意的**:
 *
 *   · 服务端**没有任何压缩库**(依赖只有 fastify 那几个),手写 zip 容器要自己算
 *     CRC32、拼中央目录 —— 为一份"给人看的日志"引入那段代码不划算;
 *   · 日志本身已是文本,每份只取尾部若干行,总量可控;
 *   · **手机上读一份 .txt 比解开一个 zip 方便得多** —— 这份东西的读者就是拿着手机的人。
 *
 * 哪天真要装 zip(比如要带上二进制产物),那时也应该是**加依赖**,而不是手写。
 *
 * ## ⛔ 必须脱敏
 *
 * 日志里**确实出现过设备 token**(HANDOVER §3.5 的 #13:nginx 把 `?token=` 记进了
 * access log)。而这份包是要从手机上带走、可能再转发给别人的。所以两道:
 *   1. 把本机上那几个已知的秘密字面量整体替换掉(配对密码、frp 的 token);
 *   2. 正则再兜一遍 `token=` / `Bearer`,防止第一个列表漏了什么。
 */

/** frp 客户端在电脑上的位置(与 `deploy/config.ps1` 无关,它是独立安装的) */
const FRP_DIR = process.env.REMOTE_CC_FRP_DIR || "";

/** 每份日志只取最后这么多 —— 日志可能有几百 MB,绝不能整份读进来 */
const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 400;

const REDACTED = "«已脱敏»";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 读文件尾部。
 *
 * ⚠️ 从字节偏移处切下去有可能把一个 UTF-8 字符劈成两半,开头会出现一个乱码字符 ——
 * 这是可以接受的(它在一行的开头,而这份东西是给人扫的,不是给程序解析的);
 * 为此去按行回退读取不划算。
 */
export async function tail(file: string, lines = TAIL_LINES, bytes = TAIL_BYTES): Promise<string> {  let handle;
  try {
    handle = await fsp.open(file, "r");
  } catch (err) {
    return `(读不到:${errText(err)})`;
  }
  try {
    const { size } = await handle.stat();
    const len = Math.min(size, bytes);
    const start = size - len;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, start);
    const tailLines = buf.toString("utf8").split(/\r?\n/).slice(-lines);
    return start > 0 ? [`…(前面还有 ${start} 字节没取)`, ...tailLines].join("\n") : tailLines.join("\n");
  } catch (err) {
    return `(读不动:${errText(err)})`;
  } finally {
    await handle.close();
  }
}

/**
 * 收集本机上"绝不该出现在诊断包里"的字面量。
 *
 * 短于 6 个字符的一律不收:那种长度的串在日志里会**误伤** —— 比如把日志里正常的
 * 片段替成「已脱敏」,反而让人以为那里原本有秘密。
 */
async function collectSecrets(): Promise<string[]> {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim().length >= 6) out.push(value.trim());
  };

  // 配对密码(首次启动自动生成的那个,见 auth.ts)
  try {
    push(await fsp.readFile(path.join(config.dataDir, "pair-password.txt"), "utf8"));
  } catch {
    // 还没生成过 —— 不是错
  }

  // frp 的鉴权 token
  try {
    const toml = FRP_DIR ? await fsp.readFile(path.join(FRP_DIR, "frpc.toml"), "utf8") : "";
    push(/auth\.token\s*=\s*"([^"]+)"/.exec(toml)?.[1]);
  } catch {
    // 换机器/没装 frp —— 不是错
  }

  return out;
}

/** 按已知的秘密替换一遍,再用正则兜一遍。导出是为了能在探针里单独断言它管用 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join(REDACTED);
  out = out.replace(/([?&]token=)[^&\s"']+/gi, `$1${REDACTED}`);
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
  return out;
}

function section(title: string, body: string): string {
  return `\n=== ${title} ===\n${body.trimEnd()}\n`;
}

/** 攒出整份诊断包。**不抛异常** —— 它自己失败就等于这条路彻底没了 */
export async function buildDiagnostics(): Promise<string> {
  const secrets = await collectSecrets();

  const [backendUp, ccSwitchUp, mihomoUp] = await Promise.all([
    probePort(config.port),
    probePort(config.upstream.ccSwitchPort),
    probePort(config.upstream.mihomoPort),
  ]);

  const live = listLive();
  const logsDir = path.join(config.dataDir, "logs");

  const parts: string[] = [
    "远程cc 诊断包",
    `生成时间 ${new Date().toISOString()}`,
    "本文件已脱敏:配对密码、frp token、设备 token 都不会出现在里面。",
  ];

  parts.push(
    section(
      "基本",
      [
        `后端版本   ${config.version}`,
        `Node      ${process.version}`,
        `平台      ${process.platform} ${process.arch}`,
        `主机名     ${os.hostname()}`,
        `已运行     ${Math.floor(process.uptime())} 秒`,
        `数据目录   ${config.dataDir}`,
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "端口",
      [
        `后端        :${config.port}   ${backendUp ? "通" : "不通"}`,
        `cc-switch   :${config.upstream.ccSwitchPort}   ${ccSwitchUp ? "通" : "不通"}`,
        `verge-mihomo :${config.upstream.mihomoPort}   ${mihomoUp ? "通" : "不通"}`,
        "",
        "⚠️ 只说明有人在那儿听,不说明那个程序是好的(凭据失效照样是「通」)。",
        "⚠️ frp(frpc/frps)探不到:它在本机没有监听端口,日志见下面那份 frpc.log。",
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "活动会话",
      live.length === 0
        ? "没有活着的会话"
        : [
            `${live.length} 个,其中 ${live.filter((s) => s.busy).length} 个在跑`,
            ...live.map(
              (s) => `  · ${s.busy ? "跑着" : "空闲"}  ${s.ccSessionId ?? s.runId}  ${s.cwd}`,
            ),
          ].join("\n"),
    ),
  );

  // ⚠️ roots 是 getter,探一遍全部盘符(网络盘会拖一下)。这里要的就是它的**结果** ——
  // 白名单宽到什么程度是 HANDOVER §3.1 那条安全项的直接证据,不给出来等于没诊断。
  const roots = config.roots;
  parts.push(
    section(
      "配置",
      [
        `公网入口   ${config.publicUrl || "(没配)"}`,
        `数据根     ${config.listDir}`,
        `白名单(${roots.length} 个)`,
        ...roots.map((r) => `  · ${r}`),
      ].join("\n"),
    ),
  );

  for (const [label, file] of [
    ["boot.log", path.join(logsDir, "boot.log")],
    ["server.err.log", path.join(logsDir, "server.err.log")],
    ["watchdog.log", path.join(logsDir, "watchdog.log")],
    // server.out.log 是 pino 的 JSON,8 MB 起 —— 尾部照取,但行数减半,免得把整份包撑爆
    ["server.out.log(尾部 120 行)", path.join(logsDir, "server.out.log")],
  ] as const) {
    const lines = label.startsWith("server.out") ? 120 : TAIL_LINES;
    parts.push(section(`日志 ${label}`, await tail(file, lines)));
  }
  if (FRP_DIR) parts.push(section("日志 frpc.log", await tail(path.join(FRP_DIR, "frpc.log"))));

  parts.push(
    section(
      "没在里面的东西",
      [
        "· nginx 的 access/error log 在 VPS 上,这边取不到 —— 要查得 ssh 上去看。",
        "· 会话正文(jsonl)不在这里面:它可能很长,而且与「后端为什么起不来」无关。",
      ].join("\n"),
    ),
  );

  return redact(parts.join("\n"), secrets);
}
