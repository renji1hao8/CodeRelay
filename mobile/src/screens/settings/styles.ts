import { StyleSheet } from "react-native";
import { theme } from "../../theme";

/**
 * 设置页各区块共用的样式。
 *
 * 拆文件之前这些散在 SettingsScreen 一个 StyleSheet 里 —— 拆开之后如果每个区块
 * 自己再定一份,同一个「分组缩进」很快就会有几个不一样的版本。所以共用的部分留在
 * 这里,只属于某一个区块的(比如操作记录的行)跟着那个区块走。
 */
export const settingsStyles = StyleSheet.create({
  /** 分组内容。不再一块一个 Card:直接连排只留缩进,靠分组标题区分 */
  group: { paddingHorizontal: theme.space(4) },

  /** 行右侧的值。和 SettingRow 的标题同号,免得两边一大一小 */
  value: { color: theme.color.textDim, fontSize: theme.font.size.md },

  notice: {
    color: theme.color.warn,
    fontSize: theme.font.size.sm,
    marginTop: theme.space(3),
    lineHeight: 19,
  },
  error: { color: theme.color.danger, fontSize: theme.font.size.sm, marginTop: theme.space(3), lineHeight: 19 },

  /** 分组下面那段说明性的小字,用来讲清楚"这一块是干什么的" */
  sectionHint: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    lineHeight: 17,
    marginBottom: theme.space(2),
  },
});
