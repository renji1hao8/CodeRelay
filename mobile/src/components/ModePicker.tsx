import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PermissionMode } from "../shared";
import { theme } from "../theme";

/**
 * 四个档位,**从松到紧**。
 *
 * ⚠️ 名字 2026-09-20 换过一轮。使用者原来的评价是「这几个档位名字太猎奇了」——
 * 旧名字是 只读 / 自动改 / 每步问,后两个口语化得看不出差别。现在改成四个两字/四字的
 * 动宾结构,同一列里能横着比:
 *
 *   只读 → 每步确认 → 自动编辑 → 全自动
 *
 * 顺序就是"放开多少",别重排(界面上的排列顺序直接就是安全感的梯度)。
 *
 * ⚠️ **不要把 `bypass` 撤掉或改回没有它的样子**:使用者明确要了这一档
 * (原话「再加一个全自动档位,bash 也放行吧」)。它落到服务端时**不是** SDK 的
 * `bypassPermissions`(那个会连 AskUserQuestion 一起废掉),见 shared 的 protocol.ts。
 */
const OPTIONS: {
  key: PermissionMode;
  label: string;
  hint: string;
  /** 危险档:选中态用红色,和另外三档在视觉上分开 */
  danger?: boolean;
}[] = [
  { key: "readonly", label: "只读", hint: "只能查看和出计划,不改动任何文件" },
  { key: "ask", label: "每步确认", hint: "每个要授权的操作都推到手机上问你" },
  { key: "acceptEdits", label: "自动编辑", hint: "文件编辑自动放行,命令仍要你批准" },
  { key: "bypass", label: "全自动", hint: "命令也不再问你,直接执行 —— 慎用", danger: true },
];

/**
 * 权限模式选择器。2×2 的网格,不是一行四个 ——
 * 四个中文标签横排会挤成一坨(而且"全自动"比另外几个长),换成网格后每个都读得清。
 */
export function ModePicker({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  return (
    <View style={styles.wrap}>
      {OPTIONS.map((opt) => {
        const active = opt.key === value;
        const onColor = opt.danger ? theme.color.danger : theme.color.accent;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[styles.item, active && { backgroundColor: onColor }]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function modeHint(mode: PermissionMode): string {
  return OPTIONS.find((o) => o.key === mode)?.hint ?? "";
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  /** 两列:让出 4px 的 gap 后各占一半 */
  item: {
    flexBasis: "49%",
    flexGrow: 1,
    alignItems: "center",
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surfaceAlt,
  },
  label: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  labelActive: { color: theme.color.onAccent, fontWeight: theme.font.weight.bold },
});
