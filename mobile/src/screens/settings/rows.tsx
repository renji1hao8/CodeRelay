import { Pressable, StyleSheet, Text, View } from "react-native";
import { SettingRow, IconButton, type IconName } from "../../components/ui";
import { theme } from "../../theme";

/** 右边一排小图标的行。刷新、检查、测试这类动作都长这样,不占一整块按钮 */
export function IconActionRow({
  title,
  subtitle,
  icon,
  iconLabel,
  onPress,
  loading,
}: {
  title: string;
  subtitle?: string;
  icon: IconName;
  iconLabel: string;
  onPress: () => void;
  loading?: boolean;
}) {
  return (
    <SettingRow
      title={title}
      subtitle={subtitle}
      /**
       * ⚠️ **整行都要能点。**
       *
       * 原来 onPress 只挂在右边那个小图标上,点标题/副标题**毫无反应** —— 而标题才是
       * 这一行最大的靶子(2026-09-19 真机上「计价设置」点了几次都没开,最后是戳到图标
       * 才开的)。图标那个按钮留着:它给的是"这里可以点"的视觉提示。
       */
      onPress={loading ? undefined : onPress}
      right={
        <IconButton
          icon={loading ? "hourglass-outline" : icon}
          onPress={onPress}
          disabled={loading}
          color={theme.color.accent}
          size={19}
          label={iconLabel}
        />
      }
    />
  );
}

/** 一行里的分段选择。放在右边,不另起一块 */
export function ChoiceRow<T extends string>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      <Text style={styles.choiceTitle}>{title}</Text>
      <View style={styles.chips}>
        {options.map((o) => (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.chip, value === o.key && styles.chipActive]}
          >
            <Text style={[styles.chipText, value === o.key && styles.chipTextActive]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  choiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingVertical: theme.space(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
    minHeight: 52,
  },
  choiceTitle: { color: theme.color.text, fontSize: theme.font.size.md, flex: 1 },
  chips: { flexDirection: "row", gap: theme.space(2) },
  chip: {
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(3),
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  chipText: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  chipTextActive: { color: theme.color.onAccent, fontWeight: theme.font.weight.bold },
});
