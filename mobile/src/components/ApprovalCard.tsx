import { useState } from "react";
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PERMISSION_TIMEOUT_MINUTES } from "../shared";
import type { PendingApproval } from "../useSessionStream";
import { theme } from "../theme";
import { CARD_MAX_H_RATIO, PREVIEW_CHARS } from "../limits";
import { toolIntent } from "../toolIntent";
import { Btn } from "./ui";

/**
 * 正文最多占这么高,长了在**卡片内部**滚。
 *
 * 卡片挂在聊天页 FlatList 之外的固定区域,它长多少,底下就被顶掉多少 ——
 * 一条长命令(比如带一大段 heredoc 的)能把三个操作按钮整个挤出屏幕,
 * 而外面是列表不是滚动容器,用户划不动也点不到。
 */
const BODY_MAX_H = Math.round(Dimensions.get("window").height * CARD_MAX_H_RATIO);

export function ApprovalCard({
  pending,
  onDecide,
  submitting,
}: {
  pending: PendingApproval;
  onDecide: (decision: "allow" | "always" | "deny", reason?: string) => void;
  /**
   * 那一下点击**已经发出、正等服务端回执**。
   *
   * 这时三个按钮全部禁用、提示语换成"等电脑确认"。为什么值得有它:`ws.send()` 返回
   * true 只代表"交给了 socket",帧仍可能没到 —— 而原来点完卡片立刻就关了,人只能
   * 靠"电脑那边有没有反应"去猜,猜不准就再点一次(使用者报的"要点好几次")。
   * 现在卡片留到回执为止,期间明确告诉他"在等",不必重复点。
   */
  submitting?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  /**
   * 暂时收起来。
   *
   * ⚠️ 这张卡**挂在列表外面**,占多高就从对话区扣掉多少 —— 而审批恰恰是**最需要
   * 翻上下文**的时候(要看它前面读了什么、改到哪一步),卡片占满半屏就看不成了。
   * 使用者的原话:「审批框不能折叠或暂时收起,导致我审批时不能看上下文加以判断」。
   *
   * 收起后只留一行标题(带工具摘要),再点一下展开。状态**不重置** —— 收起来之前
   * 选的「拒绝」和写了一半的理由都还在。
   */
  const [collapsed, setCollapsed] = useState(false);

  const intent = toolIntent(pending.tool, pending.input);
  // 认不出参数的陌生工具就把原始 JSON 摊出来 —— 审批是用户做决定的唯一依据,
  // 藏起来比显示一坨 JSON 更糟
  const body = intent.detail || JSON.stringify(pending.input, null, 2);

  return (
    <View style={styles.card}>
      <Pressable
        style={[styles.head, collapsed && styles.headCollapsed]}
        onPress={() => setCollapsed((v) => !v)}
        hitSlop={6}
        accessibilityLabel={collapsed ? "展开审批" : "收起审批,先看上下文"}
      >
        <View style={styles.dot} />
        <Text style={styles.title}>等待你批准</Text>
        {collapsed ? (
          <Text style={styles.headlineInline} numberOfLines={1}>
            {intent.headline}
          </Text>
        ) : (
          <View style={styles.headSpacer} />
        )}
        <Ionicons
          name={collapsed ? "chevron-down" : "chevron-up"}
          size={15}
          color={theme.color.warn}
        />
      </Pressable>

      {collapsed ? null : (
        <>
          <Text style={styles.headline}>{intent.description || intent.headline}</Text>
          <ScrollView style={styles.bodyBox} nestedScrollEnabled showsVerticalScrollIndicator>
            <Text style={styles.body} selectable>
              {body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}\n…` : body}
            </Text>
          </ScrollView>

          {showReason ? (
            <TextInput
              style={styles.reason}
              placeholder="说明拒绝原因,会作为反馈告诉它"
              placeholderTextColor={theme.color.textFaint}
              value={reason}
              onChangeText={setReason}
              multiline
            />
          ) : null}

          <View style={styles.actions}>
            <View style={styles.actionRow}>
              <View style={styles.actionCell}>
                <Btn
                  label={showReason ? "确认拒绝" : "拒绝"}
                  kind="danger"
                  full
                  disabled={submitting}
                  onPress={() => {
                    if (!showReason) {
                      setShowReason(true);
                      return;
                    }
                    onDecide("deny", reason.trim() || "用户在手机上拒绝了该操作");
                  }}
                />
              </View>
              <View style={styles.actionCell}>
                {/* 绿色给「总是允许」,不给「允许一次」—— 前者是最强的肯定(允许并记住规则),
                    后者只是这一次放行。原来绿色挂在中间那个,恰恰是最轻的决定。 */}
                <Btn
                  label="允许一次"
                  kind="ghost"
                  full
                  disabled={submitting}
                  onPress={() => onDecide("allow")}
                />
              </View>
              <View style={styles.actionCell}>
                <Btn
                  label="总是允许"
                  kind="ok"
                  full
                  disabled={submitting}
                  onPress={() => onDecide("always")}
                />
              </View>
            </View>
          </View>
          <Text style={styles.hint}>
            {submitting
              ? "已提交,正在等电脑确认…"
              : `${PERMISSION_TIMEOUT_MINUTES} 分钟不响应会自动拒绝 · 点标题可先收起去看上下文`}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.warnSoft,
    borderColor: theme.color.warn,
    borderWidth: 1.5,
    borderRadius: theme.radius.lg,
    padding: theme.space(4),
    margin: theme.space(3),
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.space(2), marginBottom: theme.space(2) },
  /** 收起时标题不再往下留气口 —— 那一行就是整张卡的全部 */
  headCollapsed: { marginBottom: 0 },
  /** 收起后挤在标题右边的那一小段工具摘要(完整那份在 headline 里) */
  headlineInline: { color: theme.color.textDim, fontSize: theme.font.size.xs, flex: 1 },
  /** 展开时把箭头顶到最右(和设置页的折叠块一个写法) */
  headSpacer: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.warn },
  title: { color: theme.color.warn, fontWeight: "700", fontSize: theme.font.size.md },
  headline: { color: theme.color.text, fontSize: theme.font.size.sm, marginBottom: theme.space(2) },
  /** 正文区封顶,长了在这里面滚 —— 三个按钮留在下方,永远点得到 */
  bodyBox: {
    maxHeight: BODY_MAX_H,
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
  },
  body: {
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
    padding: theme.space(3),
    lineHeight: 19,
  },
  reason: {
    marginTop: theme.space(3),
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    color: theme.color.text,
    padding: theme.space(3),
    minHeight: 60,
    textAlignVertical: "top",
  },
  actions: { marginTop: theme.space(3), gap: theme.space(2) },
  actionRow: { flexDirection: "row", gap: theme.space(2) },
  /** 三个动作等宽并排:允许 / 总是允许 / 拒绝 */
  actionCell: { flex: 1 },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2) },
});
