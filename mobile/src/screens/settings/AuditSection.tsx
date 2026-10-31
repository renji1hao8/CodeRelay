import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../theme";
import { Empty, Section, formatTime } from "../../components/ui";
import { settingsStyles as s } from "./styles";
import type { AuditRow } from "./types";

/** 默认露几条。它是出事时回溯用的,不是日常要看的东西 */
const AUDIT_PREVIEW = 8;
const actionNames: Record<string, string> = {
  "desktop.approval": "会话审批", "desktop.interrupt": "停止回复", "desktop.stopTask": "停止任务",
  "fs.download": "下载文件", "fs.upload": "上传文件", "fs.attach": "添加附件", "fs.mkdir": "新建文件夹", "fs.delete": "删除文件", "fs.export": "导出文件",
  "session.create": "新建会话", "session.resume": "继续会话", "session.rename": "修改名称", "session.archive": "归档会话", "session.interrupt": "停止回复", "session.close": "关闭会话",
  "artifact.comment": "反馈文件", "recovery.diagnostics": "导出诊断",
};

/**
 * 操作记录。
 *
 * 用处是**回溯**:某个会话莫名被接续、某个文件不见了,对着时间点就能查出是哪台设备
 * 在什么时候做的。平时不看它就只是躺着,不影响任何功能 —— 所以默认只露 8 条。
 */
export function AuditSection({ audit }: { audit: AuditRow[] }) {
  const [showAll, setShowAll] = useState(false);

  return (
    <Section title="操作记录">
      <View style={s.group}>
        <Text style={s.sectionHint}>
          查看会话、文件和设备操作记录。
        </Text>
        {audit.length === 0 ? (
          <Empty text="还没有记录" />
        ) : (
          (showAll ? audit : audit.slice(0, AUDIT_PREVIEW)).map((r) => (
            <View key={r.id} style={styles.row}>
              <Text style={[styles.action, r.result !== "ok" && { color: theme.color.danger }]}>
                {actionNames[r.action] ?? "其他操作"}
              </Text>
              <Text style={styles.target} numberOfLines={1}>
                {r.target ?? ""}
              </Text>
              <Text style={styles.time}>{formatTime(r.ts)}</Text>
            </View>
          ))
        )}
        {!showAll && audit.length > AUDIT_PREVIEW ? (
          <Pressable onPress={() => setShowAll(true)} style={styles.more}>
            <Text style={styles.moreText}>展开其余 {audit.length - AUDIT_PREVIEW} 条</Text>
            <Ionicons name="chevron-down" size={15} color={theme.color.textDim} />
          </Pressable>
        ) : null}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingVertical: theme.space(2),
    // 设置页其它行都带横线(settingRow / ChoiceRow),这一块是自绘的,补上才齐
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  // 固定宽度让右侧两列对齐成表格;宽度按最长的一类动作名("fs.delete-intent")估的
  action: { color: theme.color.text, fontFamily: theme.font.mono, fontSize: theme.font.size.xs, width: 92 },
  target: { color: theme.color.textDim, fontSize: theme.font.size.xs, flex: 1 },
  time: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  more: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(2),
    paddingVertical: theme.space(3),
  },
  moreText: { color: theme.color.textDim, fontSize: theme.font.size.sm },
});
