import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type TextStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { Highlight } from "prism-react-renderer";
import { theme } from "../theme";
import { warmPrismTheme } from "./prismTheme";

/**
 * Prism 给的是 CSS 的 style 对象,而 RN 只认 TextStyle 的一个子集。
 * 手动挑出有意义的几项,而不是整个 `as any` 过去 —— 后者会把 Web 专有的
 * 属性(textShadow、cursor…)一起带进 RN,轻则警告重则崩。
 */
function pickTextStyle(style: unknown): TextStyle {
  const s = (style ?? {}) as Record<string, unknown>;
  return {
    ...(typeof s.color === "string" ? { color: s.color } : {}),
    ...(s.fontStyle === "italic" || s.fontStyle === "normal" ? { fontStyle: s.fontStyle } : {}),
    ...(typeof s.fontWeight === "string" ? { fontWeight: s.fontWeight as TextStyle["fontWeight"] } : {}),
    ...(typeof s.textDecorationLine === "string" ? { textDecorationLine: s.textDecorationLine as TextStyle["textDecorationLine"] } : {}),
  };
}

/** 复制按钮的反馈要收回去 —— 否则"已复制"会一直挂在那里 */
const COPIED_MS = 1600;

export function CodeBlock({ code, lang, label }: { code: string; lang: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载后 setState 会警告,顺手把定时器收掉
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <View style={styles.box}>
      <View style={styles.bar}>
        <Text style={styles.lang} numberOfLines={1}>
          {label || "代码"}
        </Text>
        <Pressable onPress={copy} hitSlop={10} style={styles.copy} accessibilityLabel="复制代码">
          <Ionicons
            name={copied ? "checkmark" : "copy-outline"}
            size={13}
            color={copied ? theme.color.ok : theme.color.textFaint}
          />
          <Text style={[styles.copyText, copied && styles.copyTextDone]}>
            {copied ? "已复制" : "复制"}
          </Text>
        </Pressable>
      </View>

      {/*
        有语言才走高亮。lang 为空说明 prism 不认识这门语言(或者本来就是纯文本),
        此时按原样铺开 —— 硬拿一套不匹配的语法去染色,会把普通标识符也染花,
        比不高亮更难看。
      */}
      {lang ? (
        <Highlight theme={warmPrismTheme} code={code} language={lang}>
          {({ tokens, getTokenProps }) => (
            <Text style={styles.code} selectable>
              {tokens.map((line, i) => (
                <Text key={i}>
                  {line.map((token, j) => {
                    const { style, children } = getTokenProps({ token });
                    return (
                      <Text key={j} style={pickTextStyle(style)}>
                        {children}
                      </Text>
                    );
                  })}
                  {/* 最后一行不给换行,否则代码块底下会多出一条空行 */}
                  {i < tokens.length - 1 ? "\n" : ""}
                </Text>
              ))}
            </Text>
          )}
        </Highlight>
      ) : (
        <Text style={styles.code} selectable>
          {code}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    // 半透明叠层而不是写死的纯色:代码块会落在深浅两种气泡里,
    // 写死颜色放哪边都会有一边显得格格不入
    backgroundColor: theme.md.codeBg,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
    paddingBottom: theme.space(3),
    marginBottom: theme.space(4),
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.space(2),
  },
  lang: { color: theme.color.textFaint, fontSize: theme.font.size.xs, flexShrink: 1 },
  copy: { flexDirection: "row", alignItems: "center", gap: theme.space(1) },
  copyText: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  copyTextDone: { color: theme.color.ok },
  code: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
    color: theme.color.codeText,
    lineHeight: theme.md.codeLineHeight,
  },
});
