import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";

/**
 * 图片在对话里的最大高度。手机上按原比例铺满宽度,一张竖屏截图能占掉一屏多,
 * 把上下文全挤走 —— 所以按屏幕高度截一刀,其余靠点开看全图。
 */
const MAX_H_RATIO = 0.5;

/** 比例还没量出来时先占的位,避免图片一到就把整个列表往上顶 */
const PLACEHOLDER_H = 180;

/** 太扁太长的图(全景截图)按最小比例兜一下,免得量出来只有几像素高 */
const MIN_RATIO = 0.25;

export function ZoomableImage({ uri, caption, compact = false }: { uri: string; caption?: string; compact?: boolean }) {
  const [boxW, setBoxW] = useState(0);
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [maxH, setMaxH] = useState(360);

  useEffect(() => {
    // 高度上限跟着屏幕走。onLayout 量到的只是这个盒子自己的宽,
    // 拿不到"屏幕还剩多少高度",只能按窗口估。
    setMaxH(Math.round(Dimensions.get("window").height * MAX_H_RATIO));
  }, []);

  useEffect(() => {
    let alive = true;
    setRatio(null);
    setFailed(false);
    setLoading(true);
    Image.getSize(
      uri,
      (w, h) => {
        if (!alive) return;
        if (w > 0 && h > 0) setRatio(Math.max(w / h, MIN_RATIO));
      },
      () => {
        // 量不出尺寸不代表加载不了(某些格式拿不到 header),继续按占位尺寸走
      },
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setBoxW(e.nativeEvent.layout.width);
  }, []);

  if (failed) {
    return (
      <View style={styles.failed} onLayout={onLayout}>
        <Ionicons name="image-outline" size={16} color={theme.color.textFaint} />
        <Text style={styles.failedText} numberOfLines={2}>
          {caption ? `图片打不开:${caption}` : "图片打不开"}
        </Text>
      </View>
    );
  }

  const width = boxW || undefined;
  const limit = compact ? 108 : maxH;
  const height = ratio && boxW ? Math.min(boxW / ratio, limit) : Math.min(PLACEHOLDER_H, limit);

  return (
    <View onLayout={onLayout}>
      <Pressable onPress={() => setOpen(true)} accessibilityLabel="查看大图">
        <View style={[styles.frame, { width, height }]}>
          <Image
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            onLoad={() => setLoading(false)}
            onError={() => setFailed(true)}
            accessibilityIgnoresInvertColors
          />
          {loading ? (
            <View style={styles.spinner}>
              <ActivityIndicator size="small" color={theme.color.textFaint} />
            </View>
          ) : null}
        </View>
      </Pressable>

      {caption ? (
        <Text style={styles.caption} numberOfLines={1}>
          {caption}
        </Text>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* 点哪儿都能关掉 —— 全屏看图时不该还要去找关闭按钮 */}
        <Pressable style={styles.viewer} onPress={() => setOpen(false)} accessibilityLabel="关闭">
          <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" />
          {/*
            ⚠️ 这里原来有一条底栏:「捏合缩放请用系统看图打开」+ 一个「用系统打开」按钮
            (`Linking.openURL`)。2026-09-20 按使用者要求删掉 —— 全屏就是**看**,不需要
            再往外跳;点哪儿都能关掉这一条保持不变。
          */}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    overflow: "hidden",
  },
  spinner: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  caption: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(1) },
  failed: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(3),
    backgroundColor: theme.md.codeBg,
    borderRadius: theme.radius.md,
  },
  failedText: { color: theme.color.textFaint, fontSize: theme.font.size.sm, flexShrink: 1 },
  viewer: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.94)", justifyContent: "center" },
  viewerImage: { width: "100%", height: "100%" },
});
