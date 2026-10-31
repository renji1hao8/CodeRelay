import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { UsageRow } from "../../shared";
import {
  MAX_RULES,
  computeBill,
  formatCost,
  formatTokens,
  modelList,
  parseHm,
  parseWindows,
  since,
  startOfToday,
  type Bill,
  type PriceRule,
} from "../../billing";
import { Btn, Section, SettingRow, Sheet } from "../../components/ui";
import { theme } from "../../theme";
import { settingsStyles as s } from "./styles";
import { IconActionRow } from "./rows";

/** "今日"那一行的副标题:让使用者看得出钱花在哪一档上 */
function breakdown(bill: Bill): string {
  const parts = [
    `输入 ${formatTokens(bill.input)}`,
    `输出 ${formatTokens(bill.output)}`,
    bill.cacheRead > 0 ? `缓存读 ${formatTokens(bill.cacheRead)}` : "",
    bill.cacheWrite > 0 ? `缓存写 ${formatTokens(bill.cacheWrite)}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function emptyRule(models: string[]): PriceRule {
  return {
    id: `r${Date.now().toString(36)}`,
    // 预填第一个见过的模型 —— 大多数时候就是它,省一次点选
    model: models[0] ?? "*",
    windows: "",
    input: 0,
    cacheRead: 0,
    output: 0,
  };
}

/**
 * 账单。
 *
 * 为什么要自己配价:上游中转的价钱只有使用者知道(而且分峰谷),SDK 给的
 * `total_cost_usd` 是按 Anthropic 官方价估的,和他实际付的钱对不上。所以这边只提供
 * **算**:用量从 jsonl 里读(服务端 `/api/usage`),单价他自己填。
 *
 * ⚠️ "今日"和"近一小时"的用量都从同一份 `usage`(今日零点之后的)里切 ——
 * 近一小时在刚过零点时会跨到昨天,所以 SettingsScreen 取数时用的是
 * `min(今日零点, 一小时前)`,见那边的说明。
 */
export function BillingSection({
  // ⚠️ 这几个都给默认值:调用方传了 undefined(比如响应形状不对)时,**宁可显示空账单,
  // 也不要在渲染期抛异常** —— RN 里那会直接杀掉整个 App,代价完全不对等
  usage = [],
  models = [],
  rules = [],
  holidays = [],
  usageError = null,
  rulesBroken = false,
  holidaysBroken = false,
  onChangeRules,
  onChangeHolidays,
  onRefresh,
  busy,
  hint,
}: {
  usage?: UsageRow[];
  models?: string[];
  rules?: PriceRule[];
  /** 法定节假日(本地日期 `YYYY-MM-DD`)—— 规则上勾了"节假日不生效"的就跳过这些天 */
  holidays?: string[];
  /**
   * 用量那次请求为什么没拿到(`null` = 拿到了)。
   *
   * ⚠️ 有它的时候**上面两行一律不报金额**,显示 `—`。理由:那份数已经是上一次的,
   * 拿它当"今日花了多少"是在编。而「没拿到」和「真的没有」都写成「还没有用量」的话,
   * 使用者只能得出"账单坏了"这一个结论 —— 2026-09-21 报的就是这个。
   */
  usageError?: string | null;
  /** 手机本地那份规则**存过、但读不出来**(和"没配过"是两回事,别混着说) */
  rulesBroken?: boolean;
  holidaysBroken?: boolean;
  onChangeRules: (next: PriceRule[]) => void;
  onChangeHolidays: (next: string[]) => void;
  onRefresh: () => void;
  busy?: boolean;
  /** 折叠状态下露在外面的那句话(今日金额,或者"为什么没有金额") */
  hint?: string;
}) {
  const today = useMemo(
    () => computeBill(since(usage, startOfToday()), rules, holidays),
    [usage, rules, holidays],
  );
  const hour = useMemo(
    () => computeBill(since(usage, Date.now() - 3_600_000), rules, holidays),
    [usage, rules, holidays],
  );

  const [listOpen, setListOpen] = useState(false);
  const [editing, setEditing] = useState<PriceRule | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const save = (rule: PriceRule) => {
    const next = rules.some((r) => r.id === rule.id)
      ? rules.map((r) => (r.id === rule.id ? rule : r))
      : [...rules, rule];
    onChangeRules(next);
    setEditing(null);
  };

  const remove = (id: string) => {
    onChangeRules(rules.filter((r) => r.id !== id));
  };

  return (
    <Section title="账单" hint={hint}>
      <View style={s.group}>
        <SettingRow
          title="今日"
          subtitle={usageError ? "没拿到用量" : breakdown(today) || "还没有用量"}
          right={<Text style={styles.cost}>{usageError ? "—" : formatCost(today.cost)}</Text>}
        />
        <SettingRow
          title="近一小时"
          subtitle={usageError ? "没拿到用量" : breakdown(hour) || "这一小时还没跑过"}
          right={<Text style={styles.cost}>{usageError ? "—" : formatCost(hour.cost)}</Text>}
        />

        {/* ⚠️ 这一句是 2026-09-21 那条报障的正面回答:先把"不知道为什么没有金额"讲清楚 */}
        {usageError ? (
          <Text style={s.error}>
            没拿到用量:{usageError}
            {"\n"}上面两行因此不显示金额 —— 那是「不知道」,不是「没花钱」。点下面「刷新用量」重试。
          </Text>
        ) : null}

        {rulesBroken ? (
          <Text style={s.error}>
            手机里那份计价规则读不出来了(存过,但内容坏了)。用量不受影响,坏的是单价。
            注意:下面「添加规则」保存时会把它整个覆盖掉 —— 要是还记得原来填了什么,先别急着存。
          </Text>
        ) : rules.length === 0 ? (
          <Text style={s.notice}>
            还没配价 —— 点下面「计价设置」把单价填上,这里才会出数字。用量本身不受影响,一直在记。
          </Text>
        ) : null}
        {rules.length > 0 && today.unpricedRows > 0 ? (
          <Text style={s.notice}>
            有 {today.unpricedRows} 条用量没配到价({formatTokens(today.unpricedTokens)} tokens)
            —— 落在它们上面的钱没算进来,总额会偏小。
            {today.unpricedSlots.length > 0
              ? `\n最集中的几处:${today.unpricedSlots.map((x) => `${x.label}(${x.rows} 条)`).join("、")}`
              : ""}
            {"\n"}
            {/* ⚠️ 这句提示是有来历的:2026-09-21 使用者就是在这儿卡住的 —— 他的低价规则
                星期配成了「六日」,于是周一有 17 小时没有任何规则覆盖,而当天的量全落在
                那些小时里,账单显示 ¥0.00。光报"有多少条"看不出缺口在**时间**上。 */}
            多半是规则的「星期 / 时段」没盖到那几段:去「计价设置」补一条「星期不选、时段留空」
            的兜底规则(留空 = 全天,它只在没有更具体的规则命中时才生效)。
          </Text>
        ) : null}

        <IconActionRow
          title="计价设置"
          subtitle={
            rulesBroken
              ? "本地那份读不出来"
              : rules.length > 0
                ? `${rules.length} 条规则`
                : "按模型 + 时段配单价(峰谷)"
          }
          icon="pricetags-outline"
          iconLabel="配价"
          onPress={() => setListOpen(true)}
        />
        <IconActionRow
          title="刷新用量"
          subtitle="账单从 jsonl 里读,最长滞后十来秒"
          icon="refresh"
          iconLabel="刷新"
          onPress={onRefresh}
          loading={busy}
        />
      </View>

      {/* 规则列表 */}
      <Sheet
        visible={listOpen}
        onClose={() => setListOpen(false)}
        title="计价规则"
        subtitle="一条规则可以挂多个模型名、一天多段时段。¥/百万 token,照上游价目表的档填"
      >
        <View style={styles.sheetBody}>
          {rulesBroken ? (
            <Text style={s.error}>
              这份规则读不出来了 —— 下面看着是空的,但手机里其实存着一份坏掉的内容。
              「添加规则」保存之后会把它整个覆盖掉。
            </Text>
          ) : rules.length === 0 ? (
            <Text style={styles.empty}>还没有规则。点下面「添加规则」开始。</Text>
          ) : null}
          {rules.map((r) => (
            <View key={r.id} style={styles.ruleRow}>
              <Pressable
                style={styles.ruleMain}
                onPress={() => {
                  setFormError(null);
                  setEditing(r);
                }}
              >
                <Text style={styles.ruleModel}>{r.model}</Text>
                <Text style={styles.ruleMeta}>
                  {r.days && r.days.length > 0 ? `${r.days.map((d) => WEEKDAY_LABEL[d]).join("")} ` : "每天 "}
                  {r.windows?.trim() ? r.windows : "全天"}
                  {r.skipHolidays ? " · 节假日除外" : ""}
                </Text>
                <Text style={styles.ruleMeta}>
                  未命中 {r.input} / 命中 {r.cacheRead} / 出 {r.output} · ¥/M
                </Text>
              </Pressable>
              <Pressable onPress={() => remove(r.id)} hitSlop={8} style={styles.ruleDel}>
                <Text style={styles.ruleDelText}>删</Text>
              </Pressable>
            </View>
          ))}

          <HolidayEditor holidays={holidays} broken={holidaysBroken} onChange={onChangeHolidays} />

          <View style={styles.sheetBtns}>
            <Btn
              label={rules.length >= MAX_RULES ? `最多 ${MAX_RULES} 条` : "添加规则"}
              kind="primary"
              full
              disabled={rules.length >= MAX_RULES}
              onPress={() => {
                setFormError(null);
                setEditing(emptyRule(models));
              }}
            />
          </View>
          {rules.length >= MAX_RULES ? (
            <Text style={s.notice}>
              条数上限是 {MAX_RULES} 条:规则存在系统的安全存储里,单值超过 2KB 会**静默存不进去**
              (表现是配好了下次又没了)。要更多得换个存法。
            </Text>
          ) : null}
        </View>
      </Sheet>

      {/* 编辑一条规则 */}
      <Sheet
        visible={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `配价 · ${editing.model}` : ""}
        subtitle="时段留空 = 全天;多段用逗号隔开;跨天写 22:00-06:00"
      >
        {editing ? (
          <RuleForm
            // 按 id 重挂:表单里有一份本地文本状态(单价那几个框),换一条规则要重新初始化
            key={editing.id}
            rule={editing}
            models={models}
            error={formError}
            onCancel={() => setEditing(null)}
            onSave={(rule) => {
              const problem = validate(rule);
              if (problem) {
                setFormError(problem);
                return;
              }
              save(rule);
            }}
          />
        ) : null}
      </Sheet>
    </Section>
  );
}

/** 星期几的显示顺序:一到日(和中文习惯一致,不是西方的周日开头) */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_LABEL: Record<number, string> = {
  0: "日",
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
  6: "六",
};

/**
 * 法定节假日名单。
 *
 * 为什么要手工维护:**中国的节假日每年由国务院发布,还带调休**,内置一份很快就会过期,
 * 而过期的错没人看得见 —— 账单只是悄悄算贵了。所以名单归使用者,这里只提供编辑。
 */
function HolidayEditor({
  holidays,
  broken,
  onChange,
}: {
  holidays: string[];
  /** 存过、但读不出来 —— 此时"还是空的"这句话是假的,得说清楚 */
  broken?: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const v = draft.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      setError("填成 2026-10-01 这样(年-月-日)");
      return;
    }
    if (!holidays.includes(v)) onChange([...holidays, v].sort());
    setDraft("");
    setError(null);
  };

  return (
    <View style={styles.holidayBlock}>
      <Text style={styles.fieldLabel}>
        法定节假日(这些天走空闲;要配合规则里勾的「节假日不生效」才起作用)
      </Text>
      {holidays.length > 0 ? (
        <View style={styles.chips}>
          {holidays.map((d) => (
            <Pressable
              key={d}
              onPress={() => onChange(holidays.filter((x) => x !== d))}
              style={styles.chip}
            >
              <Text style={styles.chipText}>{d} ✕</Text>
            </Pressable>
          ))}
        </View>
      ) : broken ? (
        <Text style={s.error}>
          这份名单读不出来了(存过,但内容坏了)。下面「加上」会覆盖掉它。
        </Text>
      ) : (
        <Text style={styles.empty}>还没填 —— 不填的话,节假日会被当成普通工作日按高峰算。</Text>
      )}
      <View style={styles.fieldRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={draft}
          onChangeText={setDraft}
          placeholder="2026-10-01"
          placeholderTextColor={theme.color.textFaint}
          autoCapitalize="none"
        />
        <Btn label="加上" small onPress={add} />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

/** 保存前的校验。宁可在这儿拦住,也别把"25:99"这种时段存进去 —— 它永远不会命中 */
function validate(rule: PriceRule): string | null {
  if (!rule.model.trim()) return "模型名不能空(全部模型用 *)";
  if (parseWindows(rule.windows) === null) {
    return "时段要写成 09:00-12:00,多段用逗号隔开,例如 09:00-12:00, 14:00-18:00";
  }
  for (const [label, v] of [
    ["未命中输入", rule.input],
    ["命中输入", rule.cacheRead],
    ["输出", rule.output],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) return `${label}单价要是 0 或正数`;
  }
  return null;
}

function RuleForm({
  rule,
  models,
  error,
  onSave,
  onCancel,
}: {
  rule: PriceRule;
  models: string[];
  error: string | null;
  onSave: (rule: PriceRule) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PriceRule>(rule);
  const patch = (p: Partial<PriceRule>) => setDraft((d) => ({ ...d, ...p }));

  /**
   * ⚠️ 单价输入框里存的是**文本**,不是数字 —— 这不是洁癖,是唯一能打进小数的方法。
   *
   * 原来直接存 number、显示时再 `String(draft[key])`:打 "0.02" 的过程中,到 "0." 那一步
   * `Number("0.")` 是 0,重新渲染就成了 "0" —— **小数点当场被吃掉**,后面那个 0 永远打不上去。
   * 而缓存命中那一档恰恰全是小数(0.02 / 0.04 / 0.15 / 0.30),等于填不了价。
   * 文本原样留着,只在解析得出数字时同步进 draft;存的时候用 draft 里的数。
   */
  const [texts, setTexts] = useState<Record<string, string>>(() => ({
    input: String(rule.input ?? 0),
    cacheRead: String(rule.cacheRead ?? 0),
    output: String(rule.output ?? 0),
  }));

  const numField = (key: "input" | "cacheRead" | "output", label: string) => (
    <View style={styles.fieldInRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={texts[key]}
        onChangeText={(t) => {
          setTexts((s) => ({ ...s, [key]: t }));
          // 空 = 0(校验允许 0,不允许负);"0." 这种还没打完的**留着文本**,别回写
          if (t.trim() === "") return patch({ [key]: 0 } as Partial<PriceRule>);
          const n = Number(t);
          if (Number.isFinite(n)) patch({ [key]: n } as Partial<PriceRule>);
        }}
        // 走的时候还解析不出来(比如只剩一个 ".")就清掉,别让它以"看着有值其实没存进去"的样子留着
        onBlur={() => {
          if (!Number.isFinite(Number(texts[key]))) setTexts((s) => ({ ...s, [key]: "" }));
        }}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={theme.color.textFaint}
      />
    </View>
  );

  return (
    <View style={styles.sheetBody}>
      <Text style={styles.fieldLabel}>模型(历史里出现过的直接点)</Text>
      <View style={styles.chips}>
        {[...models, "*"].map((m) => {
          // 点一下**加进/移出**列表,而不是直接替换 —— 同一个价对应多个模型名时
          // (上游换过名字)要能一次点两个,而不是手打逗号
          const on = modelList(draft.model).includes(m);
          const toggle = () => {
            const list = modelList(draft.model);
            const next = on ? list.filter((x) => x !== m) : [...list, m];
            patch({ model: next.join(", ") });
          };
          return (
            <Pressable key={m} onPress={toggle} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                {m === "*" ? "* 全部" : m}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        style={styles.input}
        value={draft.model}
        onChangeText={(t) => patch({ model: t })}
        placeholder="模型名(或 *)"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>星期(不选 = 每天;工作日高峰就只选一~五)</Text>
      <View style={styles.chips}>
        {WEEKDAY_ORDER.map((v) => {
          const on = (draft.days ?? []).includes(v);
          return (
            <Pressable
              key={v}
              onPress={() =>
                patch({ days: on ? (draft.days ?? []).filter((x) => x !== v) : [...(draft.days ?? []), v] })
              }
              style={[styles.dayChip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{WEEKDAY_LABEL[v]}</Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={() => patch({ skipHolidays: !draft.skipHolidays })} style={styles.toggleRow}>
        <Text style={styles.toggleText}>法定节假日不生效(那天按兜底规则算)</Text>
        <View style={[styles.checkBox, draft.skipHolidays && styles.checkOn]}>
          {draft.skipHolidays ? <Text style={styles.checkMark}>✓</Text> : null}
        </View>
      </Pressable>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>时段(留空 = 全天;多段用逗号隔开)</Text>
        <TextInput
          style={styles.input}
          value={draft.windows ?? ""}
          onChangeText={(t) => patch({ windows: t })}
          placeholder="09:00-12:00, 14:00-18:00"
          placeholderTextColor={theme.color.textFaint}
          autoCapitalize="none"
        />
      </View>

      <View style={styles.fieldRow}>
        {numField("input", "未命中输入 ¥/M")}
        {numField("cacheRead", "命中输入 ¥/M")}
      </View>
      <View style={styles.fieldRow}>
        {numField("output", "输出 ¥/M")}
      </View>
      <Text style={styles.fieldNote}>
        未命中那一档要按**缓存未命中**的价填(通常比命中贵几十倍);缓存写入并进未命中算
        —— 上游价目表里没有单收这一项。
      </Text>

      {error ? <Text style={s.error}>{error}</Text> : null}

      <View style={styles.sheetBtns}>
        <Btn label="取消" onPress={onCancel} />
        <Btn label="保存" kind="primary" onPress={() => onSave(draft)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cost: { color: theme.color.text, fontSize: theme.font.size.lg, fontWeight: theme.font.weight.bold },

  sheetBody: { gap: theme.space(3), paddingBottom: theme.space(2) },
  empty: { color: theme.color.textFaint, fontSize: theme.font.size.sm },

  ruleRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  ruleMain: { flex: 1, gap: 2, paddingVertical: theme.space(2) },
  ruleModel: { color: theme.color.text, fontSize: theme.font.size.md },
  ruleMeta: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  ruleDel: { paddingHorizontal: theme.space(2), paddingVertical: theme.space(2) },
  ruleDelText: { color: theme.color.danger, fontSize: theme.font.size.sm },

  holidayBlock: { gap: theme.space(2), marginTop: theme.space(2) },
  dayChip: {
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(3),
    paddingVertical: 6,
    minWidth: 40,
    alignItems: "center",
  },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  toggleText: { color: theme.color.textDim, fontSize: theme.font.size.sm, flex: 1 },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  checkMark: { color: theme.color.onAccent, fontSize: 14, fontWeight: theme.font.weight.bold },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  chip: {
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(3),
    paddingVertical: 6,
    maxWidth: 220,
  },
  chipOn: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  chipText: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  chipTextOn: { color: theme.color.onAccent, fontWeight: theme.font.weight.bold },

  fieldRow: { flexDirection: "row", gap: theme.space(3) },
  /**
   * ⚠️ `field` **不带 flex**,`fieldInRow` 才有 —— 这两者混用是真机上量出来的重叠 bug。
   *
   * 原来两个都叫 `field`(带 `flex: 1`)。在 `fieldRow` 里它是对的;但「时段」那行是
   * **单独**放在竖列里的,`flex: 1` 在竖列里意思是"抢占剩余空间",而面板高度不够时它
   * 就被压成 0 高、内容往外溢 —— 现象是时段那行的标签整个不见、两个价格标签叠在时段
   * 输入框上(2026-09-19 控件树:时段框 y1963-2018,价格标签 y1988-2029)。
   */
  field: { gap: 4 },
  fieldInRow: { flex: 1, gap: 4 },
  fieldLabel: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  fieldNote: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 16 },
  input: {
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(3),
    paddingVertical: 8,
    color: theme.color.text,
    fontSize: theme.font.size.md,
    backgroundColor: theme.color.surfaceAlt,
  },
  sheetBtns: { flexDirection: "row", gap: theme.space(3), marginTop: theme.space(2) },
});
