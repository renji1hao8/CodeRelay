/**
 * 账单计算。
 *
 * **纯函数、不 import React/expo** —— 就为了能在裸 Node 里跑真值用例
 * (`mobile/scripts/check-billing.mjs`)。这段错起来最阴:不报错、不崩,只是**数字不对**,
 * 而"今天花了 30 还是 90"要装一次 APK、上真机看半天才可能察觉。
 *
 * 价格的形状:同一个模型可以配**多条**,按时段分开 —— 这就是"峰谷计价"。匹配的是
 * **每条用量自己的本地时间**,所以谷时跑的量自然落到谷时价上。
 */
import type { UsageRow } from "./shared";

/**
 * 规则条数上限。
 *
 * ⚠️ 这个数不是随手定的:规则存在 SecureStore 里,而它在 Android 上单值有 2KB 上下的
 * 限制,超了会**静默存不进去**(见 storage.ts 的说明)。一条规则约 140 字节,12 条留足余量。
 */
export const MAX_RULES = 12;

/**
 * 一条计价规则。单价单位:**人民币元 / 百万 token**。
 *
 * ⚠️ 三个价字段是按**上游价目表的叫法**来的,不是按 jsonl 的字段名 —— 它们之间有一次
 * 映射,搞错就会差很多(缓存命中价通常只有未命中的几十分之一):
 *
 * | 上游通常的叫法 | 对应 jsonl |
 * |---|---|
 * | `input`  缓存**未命中**输入 | `input_tokens` **+ `cache_creation_input_tokens`** |
 * | `cacheRead` 缓存**命中**输入 | `cache_read_input_tokens` |
 * | `output` 输出 | `output_tokens` |
 *
 * 缓存**创建**(cache_creation)并进未命中那一档:写入时那些 token 本来就要重新处理一遍,
 * DeepSeek 就是这么算的(价目表里根本没有"缓存写"这一项)。
 * ⚠️ 但 Anthropic 官方是**单独收**这一档的(约 1.25× 输入价)—— 哪天上游换成那种,
 * 这里就得再拆一档出来,别直接改价。
 */
export interface PriceRule {
  id: string;
  /**
   * 模型名。**可以写多个,用逗号隔开** —— 同一档价对应好几个名字时不必配两遍。
   *
   * 为什么需要:上游换过名字(实测使用者的库里 `deepseek-flash` 与 `deepseek-v4-flash`
   * 并存,而官方说明写着旧名"仍可调用、按 Flash 价格计费")。按精确匹配的话,同一档价要
   * 抄两遍,改价时漏一处就悄悄算错。
   *
   * **`*` = 兜底**,匹配所有没被专门配过的模型。
   */
  model: string;
  /**
   * 生效的星期几:**0=周日 … 6=周六**。不填(或空数组) = 每天。
   *
   * 为什么需要它:上游的高峰时段往往是"工作日才有" —— 比如 DeepSeek 是
   * 「周一至周五 9:00–12:00、14:00–18:00」,周末全天算空闲。光有时段表达不了这个。
   */
  days?: number[];
  /**
   * 法定节假日当天**不生效**(那天全天走别的规则,一般是兜底的全天规则)。
   *
   * 节假日名单是使用者自己维护的(见 HolidaysEditor 与 storage 的说明):中国的节假日
   * 每年由国务院发布、还带调休,内置一份很快就会过期,而且**过期的错没人看得见** ——
   * 账单只是悄悄算贵了。
   */
  skipHolidays?: boolean;
  /**
   * 生效时段,**可以写多段**,用逗号隔开:`09:00-12:00, 14:00-18:00`。
   * 留空 = 全天;单段允许跨天(`22:00-06:00`)。
   *
   * 为什么是一整串、而不是 from/to 两个字段:上游的高峰**一天有两段**
   * (周一至周五 9:00–12:00 与 14:00–18:00),只给一对起止就得多配一条规则 ——
   * 而"多一条规则"意味着多一次输入、多一个改价时漏掉的地方。
   */
  windows?: string;
  /** 缓存未命中输入 ¥/M(含缓存创建) */
  input: number;
  /** 缓存命中输入 ¥/M */
  cacheRead: number;
  /** 输出 ¥/M */
  output: number;
}

/** 一周的显示名。下标就是 `Date.getDay()`(0 = 周日) */
const WEEKDAY_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 没配到价的那批里,**最集中的一处**。
 *
 * ⚠️ 为什么要这个:只报"有 N 条没配到价"是**修不了**的 ——
 * 2026-09-21 使用者就是这么卡住的(他的低价规则星期配成了「六日」,于是周一有 17 小时
 * 没有任何规则覆盖,而当天的量全落在那些小时里,账单显示 ¥0.00)。
 * 他当时的问题是「这个没配上价怎么回事啊」—— 因为界面上没有任何线索指向"缺口在时间上"。
 * 报出"落在哪些模型/星期/小时"之后,一眼就能看出该补哪一段。
 */
export interface UnpricedSlot {
  /** 给人看的标签,例如 `deepseek-flash 周一 03 时` */
  label: string;
  rows: number;
  tokens: number;
}

/** 一段时间的账单小计 */
export interface Bill {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 参与了计价的条数 */
  priced: number;
  /**
   * 没配到价的用量。
   *
   * ⚠️ 必须单独露出来:否则"这个模型我没配价"的表现只是**总额偏小**,
   * 看起来像"今天用得少",而不是像"我漏配了"。
   */
  unpricedTokens: number;
  unpricedRows: number;
  /** 没配到价的那些**集中在哪几处**(按条数倒序,最多 3 条)。见 UnpricedSlot 的说明 */
  unpricedSlots: UnpricedSlot[];
}

/**
 * 解析时段串:`09:00-12:00, 14:00-18:00` → `[{from,to}, …]`(分钟数)。
 *
 * 返回 `null` = **写法有问题**(调用方必须拦住,别当成"全天");返回 `[]` = 空串 = 全天。
 * 分隔符认半角 `-` 与全角 `–`/`—`/`~`/`至` —— 从文档粘过来常常是后几种。
 */
export function parseWindows(s: string | undefined): { from: number; to: number }[] | null {
  const text = (s ?? "").trim();
  if (!text) return [];
  const out: { from: number; to: number }[] = [];
  for (const part of text.split(/[,，]/)) {
    const seg = part.trim();
    if (!seg) continue;
    const m = /^(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})$/.exec(seg);
    if (!m) return null;
    const from = parseHm(m[1]);
    const to = parseHm(m[2]);
    if (from === null || to === null) return null;
    out.push({ from, to });
  }
  return out;
}

/** 规则里写的模型名(逗号分隔,去空白) */
export function modelList(model: string): string[] {
  return model
    .split(/[,，]/)
    .map((m) => m.trim())
    .filter(Boolean);
}

/** `HH:MM`(或 `H:MM`)→ 当天的第几分钟;看不懂就返回 null */
export function parseHm(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 这条规则在 `at` 这个时刻生效吗(本地时间)。多段里**任意一段命中**就算 */
export function inWindow(rule: PriceRule, at: Date): boolean {
  const windows = parseWindows(rule.windows);
  if (windows === null) return false; // 写法坏了:不命中任何时刻(保存前的校验会先拦住)
  if (windows.length === 0) return true; // 留空 = 全天

  const now = at.getHours() * 60 + at.getMinutes();
  for (const w of windows) {
    if (w.from === w.to) return true; // 起止重合当全天,别当成"零长度窗口"
    // 跨天(如 22:00-06:00):命中条件是"在起点之后**或**在终点之前"
    if (w.from > w.to ? now >= w.from || now < w.to : now >= w.from && now < w.to) return true;
  }
  return false;
}

/** 本地日期键 `YYYY-MM-DD` —— 节假日名单就是按这个存的 */
export function dateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 这一天符合这条规则吗(星期几 + 节假日例外) */
export function onDay(rule: PriceRule, at: Date, holidays: Set<string>): boolean {
  if (rule.days && rule.days.length > 0 && !rule.days.includes(at.getDay())) return false;
  if (rule.skipHolidays && holidays.has(dateKey(at))) return false;
  return true;
}

/**
 * 给某条用量挑规则。
 *
 * 优先级:**先精确匹配模型,再 `*` 兜底**;同类里按列表顺序,先配到的先用。
 * 所以同模型的多条时段规则互不重叠时怎么写都行,重叠时以靠前的为准。
 */
export function ruleFor(
  model: string | null,
  at: Date,
  rules: PriceRule[],
  holidays: Set<string> = new Set(),
): PriceRule | null {
  const hit = (r: PriceRule) => inWindow(r, at) && onDay(r, at, holidays);
  /**
   * 同一档里有好几条命中时:**有时段的优先于"全天"的**。
   *
   * 不然"配了两条高峰 + 一条全天兜底"会永远命中全天那条 —— 因为兜底规则也满足
   * "在时段内",而列表顺序不该决定这种事的对错(界面里没有拖动排序,顺序就是添加顺序)。
   */
  const pick = (list: PriceRule[]) =>
    list.filter((r) => (r.windows ?? "").trim())[0] ?? list[0] ?? null;

  const exact = rules.filter((r) => modelList(r.model).includes(model ?? "") && hit(r));
  if (exact.length > 0) return pick(exact);
  return pick(rules.filter((r) => r.model.trim() === "*" && hit(r)));
}

/**
 * 一条用量的价钱(元)。
 *
 * 注意 `input + cacheWrite` 合成一档:**缓存写入按未命中价计**(见 PriceRule 的说明)。
 */
function costOf(row: UsageRow, rule: PriceRule): number {
  return (
    ((row.input + row.cacheWrite) / 1e6) * rule.input +
    (row.cacheRead / 1e6) * rule.cacheRead +
    (row.output / 1e6) * rule.output
  );
}

/** 本地零点。"今日"按**本地日**算 —— 和后端 /api/usage 的默认起点一致 */
export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 只留 `sinceMs` 之后的用量(按 `ts` 过滤;界面用它切"今日"和"近一小时") */
export function since(rows: UsageRow[], sinceMs: number): UsageRow[] {
  return rows.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= sinceMs;
  });
}

export function computeBill(
  rows: UsageRow[],
  rules: PriceRule[],
  /** 法定节假日(本地日期 `YYYY-MM-DD`)。规则上标了 `skipHolidays` 的日子会跳过它 */
  holidays: readonly string[] = [],
): Bill {
  const holidaySet = new Set(holidays);
  const bill: Bill = {
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    priced: 0,
    unpricedTokens: 0,
    unpricedRows: 0,
    unpricedSlots: [],
  };
  /** 没配到价的那些按「模型 + 星期 + 小时」归堆(见 UnpricedSlot 的说明) */
  const slots = new Map<string, UnpricedSlot>();

  for (const row of rows) {
    const at = new Date(row.ts);
    if (!Number.isFinite(at.getTime())) continue;
    const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
    // 全 0 的条目(CLI 的 <synthetic> 占位就是这样)直接跳过:它不花钱,但要是算进
    // "没配到价"的计数里,会平白多出一句"有 N 条没配到价"的警告,反而让人去找一个不存在的问题
    if (tokens === 0) continue;
    const rule = ruleFor(row.model, at, rules, holidaySet);
    if (!rule) {
      bill.unpricedRows += 1;
      bill.unpricedTokens += tokens;
      const label = `${row.model ?? "(没写模型)"} ${WEEKDAY_SHORT[at.getDay()]} ${String(at.getHours()).padStart(2, "0")} 时`;
      const slot = slots.get(label) ?? { label, rows: 0, tokens: 0 };
      slot.rows += 1;
      slot.tokens += tokens;
      slots.set(label, slot);
      continue;
    }
    bill.priced += 1;
    bill.cost += costOf(row, rule);
    bill.input += row.input;
    bill.output += row.output;
    bill.cacheRead += row.cacheRead;
    bill.cacheWrite += row.cacheWrite;
  }
  // 只留最集中的 3 处 —— 这一行的用途是"指出缺口在哪",不是列清单
  bill.unpricedSlots = [...slots.values()].sort((a, b) => b.rows - a.rows).slice(0, 3);
  return bill;
}

/** 金额显示。小于一分钱时别显示成 ¥0.00 —— 那看起来像"没算" */
export function formatCost(n: number): string {
  if (n > 0 && n < 0.01) return "<¥0.01";
  return `¥${n.toFixed(2)}`;
}

/** token 数显示:上万就折成 k,免得账单上一串零 */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
