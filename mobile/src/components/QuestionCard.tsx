import { useState } from "react";
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PERMISSION_TIMEOUT_MINUTES, type QuestionSpec } from "../shared";
import { theme } from "../theme";
import { CARD_MAX_H_RATIO } from "../limits";
import { Btn } from "./ui";

/**
 * 卡片正文最多占这么高,超出的部分在卡片**内部**滚动。
 *
 * 这个上限是必须的:卡片挂在聊天页 FlatList 之外的固定区域,它自己长出去多少,
 * 底下就被顶掉多少 —— 选项一多,整个卡片连同"提交"按钮一起被挤出屏幕,
 * 而外面那层是列表不是滚动容器,用户既点不到也划不动。
 */
const BODY_MAX_H = Math.round(Dimensions.get("window").height * CARD_MAX_H_RATIO);

/**
 * 单个选项里 preview 的显示上限。
 *
 * 和 limits.ts 里那个通用阈值不是一回事:那个管"整段内容要不要折叠",
 * 这个管"一个选项的预览片段",量级本来就该更小。
 */
const OPTION_PREVIEW_CHARS = 4000;

/**
 * AskUserQuestion 的作答卡片。
 *
 * 它走的是 canUseTool 审批通道(不是 request_user_dialog),所以问题跟着
 * permission_request 的 input 一起来,答案则随 permission_response 的 answers 回去 ——
 * 服务端把它合并进 updatedInput 才能被工具采纳。
 */
export function QuestionCard({
  questions,
  onAnswer,
  submitting,
}: {
  questions: QuestionSpec[];
  onAnswer: (answers: Record<string, string>) => void;
  /**
   * 那一下点击**已经发出、正等服务端回执**(和 ApprovalCard 同一个道理)。
   *
   * 提问这条尤其要防重复提交:答错一次要等 30 分钟超时,而人看到"点了没反应"的
   * 第一反应就是再点一遍 —— 那一遍多半会撞上"这条审批已经被处理过了"。
   */
  submitting?: boolean;
}) {
  // keyed by 题号:选中的 label(单选时最多一个)
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  /**
   * 暂时收起来 —— 和审批卡一个道理(见 ApprovalCard 的说明):这张卡也挂在列表**外面**,
   * 占多高就从对话区扣掉多少,而选之前往往正需要往回翻上下文。
   * 收起后已选/已填的内容都留着,再点一下接着答。
   */
  const [collapsed, setCollapsed] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[qi] ?? [];
      if (!multi) {
        // 再点一次取消,免得误点后没法改
        return { ...prev, [qi]: cur.length === 1 && cur[0] === label ? [] : [label] };
      }
      return {
        ...prev,
        [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  };

  /** 每题的答案:选中的选项 + "其他"里手输的文本,多选用逗号分隔(与工具约定一致) */
  const answerFor = (qi: number) => {
    const parts = [...(picked[qi] ?? [])];
    const typed = (other[qi] ?? "").trim();
    if (typed) parts.push(typed);
    return parts.join(", ");
  };

  const ready = questions.every((_, i) => answerFor(i).length > 0);

  const submit = () => {
    if (!ready) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(i);
    });
    onAnswer(answers);
  };

  return (
    <View style={styles.card}>
      <Pressable
        style={[styles.head, collapsed && styles.headCollapsed]}
        onPress={() => setCollapsed((v) => !v)}
        hitSlop={6}
        accessibilityLabel={collapsed ? "展开待选的问题" : "收起,先看上下文"}
      >
        <Ionicons name="help-circle-outline" size={15} color={theme.color.accent} />
        <Text style={styles.title}>需要你选一下</Text>
        {collapsed ? (
          <Text style={styles.headInline} numberOfLines={1}>
            {questions.length} 个问题 · {ready ? "已作答" : "未作答"}
          </Text>
        ) : (
          <View style={styles.headSpacer} />
        )}
        <Ionicons
          name={collapsed ? "chevron-down" : "chevron-up"}
          size={15}
          color={theme.color.accent}
        />
      </Pressable>

      {collapsed ? null : (
        <>
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            {questions.map((q, qi) => {
              const multi = q.multiSelect === true;
              const cur = picked[qi] ?? [];
              return (
                <View key={qi} style={styles.question}>
                  <View style={styles.qHead}>
                    {q.header ? <Text style={styles.chip}>{q.header}</Text> : null}
                    <Text style={styles.qText}>{q.question}</Text>
                  </View>

                  {q.options.map((opt) => {
                    const on = cur.includes(opt.label);
                    return (
                      <Pressable
                        key={opt.label}
                        onPress={() => toggle(qi, opt.label, multi)}
                        style={({ pressed }) => [
                          styles.option,
                          on && styles.optionOn,
                          pressed && { backgroundColor: theme.color.surfacePress },
                        ]}
                      >
                        <Ionicons
                          name={
                            multi
                              ? on
                                ? "checkbox"
                                : "square-outline"
                              : on
                                ? "radio-button-on"
                                : "radio-button-off"
                          }
                          size={16}
                          color={on ? theme.color.accent : theme.color.textFaint}
                        />
                        <View style={styles.optBody}>
                          <Text style={[styles.optLabel, on && { color: theme.color.accent }]}>
                            {opt.label}
                          </Text>
                          {opt.description ? (
                            <Text style={styles.optDesc}>{opt.description}</Text>
                          ) : null}
                          {/* preview 原本是给终端/网页渲染的片段,手机上先按等宽纯文本给出来。
                              正文现在能滚了,所以这里不用再狠截 —— 保持能看全 */}
                          {opt.preview ? (
                            <Text style={styles.optPreview} selectable>
                              {opt.preview.length > OPTION_PREVIEW_CHARS
                                ? `${opt.preview.slice(0, OPTION_PREVIEW_CHARS)}\n…`
                                : opt.preview}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}

                  {/*
                    工具的说明里写明「不会有 Other 选项,那个由 UI 自动提供」,
                    所以这个入口得我们自己补 —— 否则用户遇到选项都不合适时无路可走。
                  */}
                  <Pressable
                    onPress={() => setOtherOpen((p) => ({ ...p, [qi]: !p[qi] }))}
                    style={styles.otherToggle}
                    hitSlop={4}
                  >
                    <Ionicons
                      name={otherOpen[qi] ? "remove-circle-outline" : "add-circle-outline"}
                      size={15}
                      color={theme.color.textDim}
                    />
                    <Text style={styles.otherLabel}>其他…</Text>
                  </Pressable>
                  {otherOpen[qi] ? (
                    <TextInput
                      style={styles.otherInput}
                      placeholder="直接说你的答案"
                      placeholderTextColor={theme.color.textFaint}
                      value={other[qi] ?? ""}
                      onChangeText={(t) => setOther((p) => ({ ...p, [qi]: t }))}
                      multiline
                    />
                  ) : null}
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.actions}>
            <Btn
              label={submitting ? "已提交,等电脑确认…" : ready ? "提交选择" : "请先作答"}
              kind="primary"
              onPress={submit}
              disabled={!ready || submitting}
              loading={submitting}
              full
            />
          </View>
          <Text style={styles.hint}>
            {submitting
              ? "收到电脑的回执就把这张卡收掉;等不到会让它可以再点"
              : `${PERMISSION_TIMEOUT_MINUTES} 分钟不响应会按「不回答」处理 · 点标题可先收起去看上下文`}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.accentSoft,
    borderColor: theme.color.accent,
    borderWidth: 1.5,
    borderRadius: theme.radius.lg,
    padding: theme.space(4),
    margin: theme.space(3),
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.space(2), marginBottom: theme.space(3) },
  /** 收起时那一行就是整张卡的全部,不再往下留气口 */
  headCollapsed: { marginBottom: 0 },
  /** 收起后挤在标题右边的一小段进度 */
  headInline: { color: theme.color.textDim, fontSize: theme.font.size.xs, flex: 1 },
  /** 展开时把箭头顶到最右(和设置页的折叠块一个写法) */
  headSpacer: { flex: 1 },
  title: { color: theme.color.accent, fontWeight: "700", fontSize: theme.font.size.md },

  /** 正文区封顶,超出的在这里面滚。按钮留在卡片底部不动,永远点得到 */
  body: { maxHeight: BODY_MAX_H },
  bodyContent: { paddingRight: 2 },

  question: { marginBottom: theme.space(3) },
  qHead: { flexDirection: "row", alignItems: "center", gap: theme.space(2), marginBottom: theme.space(2) },
  chip: {
    color: theme.color.accent,
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.bold,
    backgroundColor: theme.color.surfaceAlt,
    borderRadius: theme.radius.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  qText: { color: theme.color.text, fontSize: theme.font.size.sm, flex: 1, lineHeight: 19 },

  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  optionOn: { borderColor: theme.color.accent, borderWidth: 1 },
  optBody: { flex: 1, gap: 2 },
  optLabel: { color: theme.color.text, fontSize: theme.font.size.sm, fontWeight: theme.font.weight.semibold },
  optDesc: { color: theme.color.textDim, fontSize: theme.font.size.xs, lineHeight: 17 },
  optPreview: {
    color: theme.color.codeText,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
    marginTop: theme.space(1),
    lineHeight: 16,
  },

  otherToggle: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: theme.space(1) },
  otherLabel: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  otherInput: {
    marginTop: theme.space(2),
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    color: theme.color.text,
    padding: theme.space(3),
    minHeight: 52,
    textAlignVertical: "top",
    fontSize: theme.font.size.sm,
  },

  actions: { marginTop: theme.space(1) },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2) },
});
