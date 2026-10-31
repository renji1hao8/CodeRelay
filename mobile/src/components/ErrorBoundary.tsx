import { Component, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

/**
 * 渲染期兜底(错误边界)。
 *
 * ⚠️ **为什么必须有**:RN 里渲染期抛异常**直接杀掉进程**,不是显示一块红字。
 * 2026-09-19 一天里栽了两次 —— 一次是账单块读了个 undefined(`since(usage)`),
 * 一次是文件页把 `roots` 当数组用。两次的代价都是"App 没了、用户以为坏了",
 * 而根因都只是**一个响应形状不对**。
 *
 * 有了它:坏掉的是那一块(App 还在、别的还能用),界面上写着出错原因,
 * 而且**不必重装 App** 就能退出去重进。
 *
 * 故意不 import `./ui` —— 那个文件要用它(见 `Section`),互相 import 会成环。
 * 所以这里只用 RN 原语,样式自己带。
 */
interface Props {
  children: ReactNode;
  /** 出问题时告诉使用者"是哪一块" —— 没有它只能说"这里出错了",指向性差很多 */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 真机上跑的时候,这行会进 adb logcat —— 排查时按 "boundary" 搜
    console.warn("[boundary]", error?.message ?? String(error));
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.wrap}>
        <View style={styles.card}>
          <Text style={styles.title}>{this.props.label ?? "这一块"}出错了</Text>
          <Text style={styles.message}>{String(error?.message ?? error)}</Text>
          <Text style={styles.hint}>
            其他部分还能用。点下面重试;要是还不行,把这行字发给我。
          </Text>
          <Pressable style={styles.btn} onPress={() => this.setState({ error: null })}>
            <Text style={styles.btnText}>重试</Text>
          </Pressable>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: theme.space(4), paddingVertical: theme.space(3) },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.danger,
    backgroundColor: theme.color.surfaceAlt,
    padding: theme.space(3),
    gap: 6,
  },
  title: { color: theme.color.danger, fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold },
  message: { color: theme.color.textDim, fontSize: theme.font.size.sm, lineHeight: 19 },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 17 },
  btn: {
    alignSelf: "flex-start",
    marginTop: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    paddingHorizontal: theme.space(4),
    paddingVertical: 6,
  },
  btnText: { color: theme.color.text, fontSize: theme.font.size.sm },
});
