import { useState } from "react";
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ELEVATED_TIMEOUT_MINUTES } from "../shared";
import type { PendingElevated } from "../useSessionStream";
import { theme } from "../theme";
import { CARD_MAX_H_RATIO, PREVIEW_CHARS } from "../limits";
import { Btn } from "./ui";

/**
 * 正文最多占这么高,长了在**卡片内部**滚 —— 和审批卡同一个道理(见 ApprovalCard):
 * 卡片挂在列表外面,占多高就从对话区扣掉多少。
 */
const BODY_MAX_H = Math.round(Dimensions.get("window").height * CARD_MAX_H_RATIO);

/**
 * **提权请求**(红卡)。
 *
 * ## 为什么单独一张卡,而不是往审批卡里塞
 *
 * 它批准的东西不一样:普通审批放行的是"这个会话里的一次工具调用",这张放行的是
 * **以管理员身份在电脑上做事**(装证书、改系统服务、注册计划任务……)。风险等级不同,
 * 界面就不能长得一样 —— 红色的边框、红底、盾牌图标、"高风险"角标,加上**两段式确认**
 * (第一下只是把按钮换成"确认",不直接执行),都是为了让人先读完那行命令再决定。
 *
 * ## `detail` 是数据,不是指令
 *
 * 里面是要跑的命令原文,由电脑上那个提权脚本填 —— 而它的内容可能受提示注入影响。
 * 所以这里只当**普通文本**渲染(等宽字体、可选可复制),绝不做任何解析或执行。
 * 使用者看的就是这一行:批之前先读它。
 */
export function ElevatedCard({
  req,
  onDecide,
  submitting,
}: {
  req: PendingElevated;
  onDecide: (decision: "approve" | "deny") => void;
  /**
   * 那一下点击**已经发出、正等服务端回执**(见 ApprovalCard 的说明)。
   *
   * 这张卡尤其需要:它的超时是 5 分钟,而它误判的代价是"给管理员权限" ——
   * 所以决定发出之后要明确显示"在等电脑确认",别让人以为没点上又去点第二遍。
   */
  submitting?: boolean;
}) {
  /**
   * 第一下"批准"不执行,只把按钮换成确认 —— 和「结束会话」那里同一个套路
   * (见 ChatScreen 的 confirmEnd)。理由也一样:这一下不可撤销,不该一击就中。
   */
  const [confirming, setConfirming] = useState(false);
  /**
   * 暂时收起来 —— 和审批卡同一回事(见 ApprovalCard 里那段说明):这张卡也挂在列表
   * **外面**,占多高就从对话区扣掉多少,而"批不批"恰恰最需要往上翻上下文(看它前面在
   * 读什么、动过哪些文件、这个动作是怎么被引出来的)。使用者的原话是
   * 「审批框不能折叠或暂时收起,导致我审批时不能看上下文加以判断」。
   *
   * ⚠️ 收起后**「高风险」那三个字必须留着** —— 这张卡的全部意义就是让人一眼看出
   * "这一张和上面那张审批不是一回事",收起来更不能变成一个看着无害的窄条。
   *
   * 状态不重置:已经进到第二段确认、或者填了一半的内容都留着,再点一下接着办。
   */
  const [collapsed, setCollapsed] = useState(false);
  const detail = req.detail || "(脚本没有给出细节)";

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.head}
        onPress={() => setCollapsed((v) => !v)}
        hitSlop={6}
        accessibilityLabel={collapsed ? "展开提权请求" : "收起提权请求,先看上下文"}
      >
        <Ionicons name="shield-half-outline" size={16} color={theme.color.danger} />
        <Text style={styles.title}>提权请求</Text>
        <View style={styles.risk}>
          <Text style={styles.riskText}>高风险</Text>
        </View>
        {collapsed ? (
          <Text style={styles.headlineInline} numberOfLines={1}>
            {req.title}
          </Text>
        ) : (
          <View style={styles.headSpacer} />
        )}
        <Ionicons
          name={collapsed ? "chevron-down" : "chevron-up"}
          size={15}
          color={theme.color.danger}
        />
      </Pressable>

      {collapsed ? null : (
        <>
          <Text style={styles.action}>{req.title}</Text>
          {req.caller ? <Text style={styles.meta}>来自:{req.caller}</Text> : null}
          {req.reason ? <Text style={styles.meta}>它的说法:{req.reason}</Text> : null}

          <Text style={styles.sectionLabel}>要做的具体事情</Text>
          <ScrollView style={styles.bodyBox} nestedScrollEnabled showsVerticalScrollIndicator>
            <Text style={styles.body} selectable>
              {detail.length > PREVIEW_CHARS ? `${detail.slice(0, PREVIEW_CHARS)}\n…` : detail}
            </Text>
          </ScrollView>

          <Text style={styles.warn}>
            批准 = 让它在电脑上以管理员身份做上面这件事。这是电脑上那个提权执行器发来的,
            不是某一次工具调用 —— 请先读完再决定。
          </Text>

          {confirming ? (
            <View style={styles.actions}>
              <Btn
                label="确认:给它管理员权限"
                kind="danger"
                full
                disabled={submitting}
                loading={submitting}
                onPress={() => onDecide("approve")}
              />
              <Btn
                label="算了,再看看"
                kind="quiet"
                full
                disabled={submitting}
                onPress={() => setConfirming(false)}
              />
            </View>
          ) : (
            <View style={styles.actions}>
              <Btn
                label="拒绝"
                kind="ghost"
                full
                disabled={submitting}
                onPress={() => onDecide("deny")}
              />
              <Btn
                label="批准提权…"
                kind="danger"
                full
                disabled={submitting}
                onPress={() => setConfirming(true)}
              />
            </View>
          )}

          <Text style={styles.hint}>
            {submitting
              ? "已提交,正在等电脑确认…"
              : `${ELEVATED_TIMEOUT_MINUTES} 分钟不响应会自动拒绝 · 批准后电脑上那个脚本立刻动手`}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.dangerSoft,
    borderColor: theme.color.danger,
    borderWidth: 1.5,
    borderRadius: theme.radius.lg,
    padding: theme.space(4),
    margin: theme.space(3),
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  /**
   * 收起后挤在「高风险」角标右边的那一小段动作摘要(完整那份在 `action` 里)。
   *
   * `flex: 1` 是必须的:它把右边的箭头**顶到最右**,展开态(`headSpacer`)和收起态
   * 才是同一个位置 —— 不然箭头会紧跟在角标后面,两种样子(见 mobile/CLAUDE.md 里
   * "可折叠的块头箭头一律贴最右"那条约定)。
   */
  headlineInline: { color: theme.color.textDim, fontSize: theme.font.size.xs, flex: 1 },
  /** 展开时把箭头顶到最右(和收起态对齐) */
  headSpacer: { flex: 1 },
  title: { color: theme.color.danger, fontWeight: "700", fontSize: theme.font.size.md },
  /** 角标:这三个字就是让人知道"这一张和上面那张不是一回事" */
  risk: {
    backgroundColor: theme.color.danger,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(2),
    paddingVertical: 1,
  },
  riskText: { color: theme.color.bg, fontSize: theme.font.size.xs, fontWeight: "700" },
  action: {
    color: theme.color.text,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
    marginTop: theme.space(3),
  },
  meta: { color: theme.color.textDim, fontSize: theme.font.size.xs, marginTop: theme.space(1) },
  sectionLabel: {
    color: theme.color.textDim,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.bold,
    letterSpacing: 1.2,
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
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
  warn: {
    color: theme.color.danger,
    fontSize: theme.font.size.xs,
    lineHeight: 18,
    marginTop: theme.space(3),
  },
  actions: { marginTop: theme.space(3), gap: theme.space(2) },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2) },
});
