import { useState, type ComponentProps, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { peek, put } from "../cache";
import { ErrorBoundary } from "./ErrorBoundary";
import { theme } from "../theme";
import { withAlpha } from "../util";

export type IconName = ComponentProps<typeof Ionicons>["name"];

/** 全站统一的区域设置。formatTime / formatSize 都由它派生,写死容易漂 */
const LOCALE = "zh-CN";

/** 列表行左侧图标方块的大小 */
const LIST_ICON_SIZE = 38;

/**
 * 列表行里文字的左边界 = 行内边距 + 图标宽 + 间隙。
 *
 * 需要在图标右侧对齐一条分隔线时用它。InboxScreen 与 FilesScreen 原先各自
 * 硬写了 66,改一次图标尺寸就会有一处悄悄对不齐。
 */
export const LIST_TEXT_INDENT = theme.space(4) + LIST_ICON_SIZE + theme.space(3);

// ---------------------------------------------------------------- 容器

export function Card({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: ViewStyle;
  padded?: boolean;
}) {
  return <View style={[styles.card, padded && styles.cardPadded, style]}>{children}</View>;
}

// ---------------------------------------------------------------- 按钮

type BtnKind = "primary" | "ghost" | "danger" | "ok" | "quiet";

export function Btn({
  label,
  onPress,
  kind = "ghost",
  icon,
  small,
  disabled,
  loading,
  full,
}: {
  label: string;
  onPress: () => void;
  kind?: BtnKind;
  icon?: IconName;
  small?: boolean;
  disabled?: boolean;
  loading?: boolean;
  full?: boolean;
}) {
  const palette: Record<BtnKind, { bg: string; fg: string; border: string }> = {
    primary: { bg: theme.color.accent, fg: theme.color.onAccent, border: theme.color.accent },
    ok: { bg: theme.color.ok, fg: theme.color.onAccent, border: theme.color.ok },
    // 危险操作的描边必须用 danger 自己 —— 换成 theme.color.border 那种近底色的
    // 灰在深色底上根本看不见,看起来就像"拒绝"没有边框
    danger: { bg: "transparent", fg: theme.color.danger, border: theme.color.danger },
    quiet: { bg: "transparent", fg: theme.color.textDim, border: "transparent" },
    ghost: { bg: theme.color.surfaceAlt, fg: theme.color.text, border: theme.color.border },
  };
  const p = palette[kind];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        full && { alignSelf: "stretch" },
        {
          backgroundColor: pressed ? theme.color.surfacePress : p.bg,
          borderColor: p.border,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={p.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 15 : 17} color={p.fg} /> : null}
          <Text style={[styles.btnText, small && styles.btnTextSmall, { color: p.fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

/** 只有图标的方形按钮,用于头部操作 */
export function IconButton({
  icon,
  onPress,
  color = theme.color.text,
  size = 20,
  disabled,
  label,
}: {
  icon: IconName;
  onPress: () => void;
  color?: string;
  size?: number;
  disabled?: boolean;
  /** 无障碍名。纯图标按钮对读屏用户是空的,这里补一句 */
  label?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.iconBtn,
        pressed && { backgroundColor: theme.color.surfacePress },
        disabled && { opacity: 0.35 },
      ]}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- 文本类

export function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: withAlpha(color, 0.4), backgroundColor: withAlpha(color, 0.1) }]}>
      <Text style={[styles.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/**
 * 设置项的一行:左边是什么,右边是控件。
 *
 * 设置页里所有条目都走它 —— 不再有"一行标签 + 下面一大块输入框"那种两段式,
 * 一屏能看完的东西就不用滑。
 */
export function SettingRow({
  title,
  subtitle,
  right,
  onPress,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle ? <Text style={styles.settingSub}>{subtitle}</Text> : null}
      </View>
      {right}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.settingRow, pressed && { backgroundColor: theme.color.surfacePress }]}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={styles.settingRow}>{body}</View>;
}

/**
 * 可复制的一行。设置页里那些长串(网络 ID、电脑地址)用它 ——
 * 点右边的图标就进剪贴板,不用再拖着选中蓝条去复制。
 *
 * 给了 onEdit 就多一个铅笔 —— 一行里同时容纳"看值、复制、改值",
 * 不必为可编辑再单起一行。
 */
export function CopyRow({
  label,
  value,
  mono = true,
  onEdit,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onEdit?: () => void;
}) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(value);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      // 复制失败也没什么可做的 —— 值本来就显示在屏幕上
    }
  };

  return (
    <View style={styles.settingRow}>
      <Text style={[styles.settingTitle, { flex: 1 }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.copyWrap}>
        <Text
          style={[styles.copyValue, mono && { fontFamily: theme.font.mono }]}
          numberOfLines={1}
          selectable
        >
          {value}
        </Text>
        {onEdit ? (
          <Pressable onPress={onEdit} hitSlop={12} style={styles.copyBtn}>
            <Ionicons name="pencil-outline" size={15} color={theme.color.textDim} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => void copy()} hitSlop={12} style={styles.copyBtn}>
          <Ionicons
            name={done ? "checkmark" : "copy-outline"}
            size={16}
            color={done ? theme.color.ok : theme.color.textDim}
          />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * 带经典开关的一行。用系统的 Switch 而不是自绘的"开/关"按钮 ——
 * 开关长什么样、往哪边拨是开,用户不用想。
 */
export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.settingRow, disabled && { opacity: 0.5 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle ? <Text style={styles.settingSub}>{subtitle}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.color.surfacePress, true: theme.color.accentSoft }}
        thumbColor={value ? theme.color.accent : theme.color.textDim}
        ios_backgroundColor={theme.color.surfacePress}
      />
    </View>
  );
}

/**
 * 设置页的"二级块"(链路 / 后台通知 / 推送通道 / 下载 / 设备 / 账单 / 操作记录 / 危险操作)。
 *
 * **默认折叠**,点标题展开。理由很实际:设置项越加越多,全平铺出来要划好几屏,而每次
 * 进来真正要动的通常只有一块。
 *
 * ⚠️ 展开状态放**内存缓存**、不放组件 state:切标签页会把设置页整屏卸载(App 是条件
 * 渲染),放组件里的话折好的块切走再回来又全展开了 —— 和会话页那个目录折叠是同一个坑
 * (见 SessionsScreen 的 COLLAPSE_KEY)。用 title 当键:标题稳定且唯一。
 *
 * `hint` 是折叠时露在外面的一句话摘要(比如「今日 ¥12.3」):全折起来之后至少还看得见
 * 一眼信息,不用挨个点开。
 */
const OPEN_SECTIONS = "settings-open-sections";

export function Section({
  title,
  children,
  hint,
}: {
  title: string;
  children: ReactNode;
  hint?: string;
}) {
  const [open, setOpen] = useState(() => (peek<string[]>(OPEN_SECTIONS) ?? []).includes(title));

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      const saved = new Set(peek<string[]>(OPEN_SECTIONS) ?? []);
      if (next) saved.add(title);
      else saved.delete(title);
      put(OPEN_SECTIONS, [...saved]);
      return next;
    });
  };

  return (
    <View style={{ marginBottom: theme.space(5) }}>
      <Pressable onPress={toggle} hitSlop={6} style={styles.sectionHead}>
        {/*
          ⚠️ 标题那一组要 `flex: 1`,箭头才**一律贴最右**。
          不给的话:带 `hint` 的块(比如账单的"今日 ¥12.3")因为 hint 会撑开、箭头被顶到
          右边,而不带 hint 的块箭头就紧跟在标题后面 —— 同一列里两种样子。
          2026-09-20 使用者原话:「只有账单的折叠是右对齐的,其他都跟在文字后」。
        */}
        <View style={styles.sectionHeadMain}>
          <Text style={styles.sectionTitle} numberOfLines={1}>
            {title}
          </Text>
          {hint ? (
            <Text style={styles.sectionHint} numberOfLines={1}>
              {hint}
            </Text>
          ) : null}
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={15} color={theme.color.textFaint} />
      </Pressable>
      {open ? <ErrorBoundary label={title}>{children}</ErrorBoundary> : null}
    </View>
  );
}

/**
 * 列表行之间的分割线。
 *
 * ⚠️ 它是**缩进**的(从文字起始处画起),不是通铺到左边缘 —— 带图标/树形缩进的列表里
 * 通铺会显得毛。2026-09-20 使用者对比后要求"都用文件页那个":所以这份提到公共组件里,
 * 文件页、会话页、设置页共用同一条。
 *
 * `inset` 给调用方对齐自己的文字缩进(文件页用 LIST_TEXT_INDENT,会话页按目录层级算)。
 */
export function ListSeparator({ inset = LIST_TEXT_INDENT }: { inset?: number }) {
  return <View style={[styles.listSep, { marginLeft: inset }]} />;
}

export function Empty({ text, icon = "file-tray-outline" }: { text: string; icon?: IconName }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={34} color={theme.color.textFaint} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- 页头

/**
 * 统一的页头。左右各留 44 宽,保证中间的标题在任何页面都居中。
 */
export function Header({
  title,
  subtitle,
  onBack,
  backIcon = "chevron-back",
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backIcon?: IconName;
  right?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        {onBack ? <IconButton icon={backIcon} onPress={onBack} size={22} /> : null}
      </View>
      <View style={styles.headerCenter}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.headerSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[styles.headerSide, { alignItems: "flex-end" }]}>{right}</View>
    </View>
  );
}

// ---------------------------------------------------------------- 列表行

/** 带图标的一行。文件浏览、设置项都用它,保证行高和留白一致 */
export function ListRow({
  icon,
  iconColor = theme.color.textDim,
  iconBg,
  title,
  subtitle,
  right,
  onPress,
  onLongPress,
  dim,
}: {
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  dim?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: theme.color.surfacePress }]}
    >
      {icon ? (
        <View style={[styles.listIcon, iconBg ? { backgroundColor: iconBg } : null]}>
          <Ionicons name={icon} size={19} color={iconColor} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.listTitle, dim && { color: theme.color.textDim }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.listSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

// ---------------------------------------------------------------- 底部弹层

/**
 * 从底部升起的操作面板。比 Alert 更适合"列几个动作让我选"。
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      {/*
        ⚠️ 下面这两层是给**键盘**和**高内容**准备的,不是装饰:

        ① KeyboardAvoidingView —— Modal 在 Android 上不跟着软键盘 resize。而面板里
           最该填的恰好是最下面那几个(单价、时段),一点就被键盘整个盖住,划不上去。
        ② ScrollView —— 面板贴在屏幕底部,内容比剩余空间高的时候,里面的 `flex: 1`
           子项会被**压扁**:2026-09-19 真机量出来「时段」那行的标签被挤成 0 高、
           而两个价格标签叠在时段输入框上(时段框 y1963-2018,价格标签 y1988-2029)。
           能滚就不会压 —— 顺带所有带输入框的面板(新建文件夹、改地址)一起受益。
      */}
      <KeyboardAvoidingView
        style={styles.sheetWrap}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        pointerEvents="box-none"
      >
        <View style={styles.sheet}>
          <View style={styles.sheetGrip} />
          {title ? (
            <Text style={styles.sheetTitle} numberOfLines={2}>
              {title}
            </Text>
          ) : null}
          {subtitle ? (
            <Text style={styles.sheetSub} numberOfLines={3}>
              {subtitle}
            </Text>
          ) : null}
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetScrollBody}
            // 键盘开着时第一下就点到按钮上(否则"保存""加上"要点两次)
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------- 输入框

/**
 * 面板(`Sheet`)里的单行输入框。
 *
 * 为什么抽出来:建文件夹、给会话改名(聊天页 / 会话列表两处)都要它,而原来是
 * **每处各写一份 `sheetInput` 样式** —— 改一次外观要改三处,漏一处就是"这两个框
 * 长得不一样"。样式值取自原先 FilesScreen 那一份,视觉不变。
 *
 * ⚠️ 高度靠 `paddingVertical` 撑,**不写死 height**:中文字体带 `includeFontPadding`,
 * 写死高度在部分机型上会切掉下沿(执行结果那边踩过同一个坑)。
 * 占位符颜色也在这里定死 —— 少写一个 `placeholderTextColor`,那个框在深色主题下
 * 就变成系统默认的深灰,几乎看不见。
 */
export function SheetInput({ style, ...rest }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={theme.color.textFaint}
      {...rest}
      style={[styles.sheetInput, style]}
    />
  );
}

// ---------------------------------------------------------------- 格式化

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return d.toLocaleDateString(LOCALE, { month: "numeric", day: "numeric" });
}

// ---------------------------------------------------------------- 样式

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    marginBottom: theme.space(3),
    overflow: "hidden",
  },
  cardPadded: { padding: theme.space(4) },

  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(2),
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 11,
    paddingHorizontal: theme.space(4),
    minHeight: 44,
  },
  btnSmall: { paddingVertical: 7, paddingHorizontal: theme.space(3), minHeight: 34 },
  btnText: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold },
  btnTextSmall: { fontSize: theme.font.size.sm },

  iconBtn: { width: 36, height: 36, borderRadius: theme.radius.sm, alignItems: "center", justifyContent: "center" },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  badgeText: { fontSize: theme.font.size.xs, fontWeight: theme.font.weight.semibold },

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: theme.space(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
    gap: theme.space(3),
  },
  rowLabel: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  rowValue: { color: theme.color.text, fontSize: theme.font.size.sm, flexShrink: 1, textAlign: "right" },

  /** 设置页的一行。和 Row 的区别是右边可以放任意控件,行高也统一抬高一点好放开关 */
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingVertical: theme.space(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
    minHeight: 52,
  },
  settingTitle: { color: theme.color.text, fontSize: theme.font.size.md },
  settingSub: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 16 },
  copyWrap: { flexDirection: "row", alignItems: "center", gap: theme.space(2), flexShrink: 1 },
  copyValue: { color: theme.color.textDim, fontSize: theme.font.size.sm, flexShrink: 1 },
  copyBtn: { padding: 4 },

  /** 分组标题不再缩成小字 —— 之前是 11px,比它下面那些行还小,看着像注解而不是标题 */
  /** 列表行之间的分割线,配合 `ListSeparator` 用 */
  listSep: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },

  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    marginTop: theme.space(1),
    marginBottom: theme.space(2),
    marginLeft: theme.space(1),
    // 一级目录(块头)下面也画一条:整页没有横线时,折起来的那些块会糊成一片
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
    minHeight: 30,
  },
  /** 标题 + 摘要。占满剩下的宽度,把箭头挤到最右(见上面那段注释) */
  sectionHeadMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
  },
  sectionTitle: {
    color: theme.color.text,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.bold,
    flexShrink: 1,
  },
  /** 折叠着也露一眼(比如账单的今日金额)。靠右、贴着箭头 */
  sectionHint: { color: theme.color.textFaint, fontSize: theme.font.size.sm, flex: 1, textAlign: "right" },

  empty: { paddingVertical: theme.space(16), alignItems: "center", gap: theme.space(3) },
  emptyText: { color: theme.color.textFaint, fontSize: theme.font.size.sm, textAlign: "center" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    gap: theme.space(2),
  },
  headerSide: { width: 44, justifyContent: "center" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { color: theme.color.text, fontSize: theme.font.size.lg, fontWeight: theme.font.weight.semibold },
  headerSub: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: 2 },

  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
    minHeight: 56,
  },
  listIcon: {
    width: LIST_ICON_SIZE,
    height: LIST_ICON_SIZE,
    borderRadius: theme.radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfaceAlt,
  },
  listTitle: { color: theme.color.text, fontSize: theme.font.size.md },
  listSub: { color: theme.color.textFaint, fontSize: theme.font.size.xs },

  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.overlay,
  },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceAlt,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(8),
    paddingTop: theme.space(3),
  },
  sheetGrip: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.borderStrong,
    marginBottom: theme.space(4),
  },
  sheetInput: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    color: theme.color.text,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
    fontSize: theme.font.size.md,
  },
  sheetTitle: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold },
  sheetSub: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2), lineHeight: 17 },
  /** 内容比剩余空间高时**缩自己**,而不是把里面的孩子压扁(见 Sheet 的注释) */
  sheetScroll: { flexShrink: 1 },
  sheetScrollBody: { gap: theme.space(2), marginTop: theme.space(3) },
});
