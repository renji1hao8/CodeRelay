import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  IMAGE_TIERS,
  outputSizeOf,
  tokenEstimateOf,
  type ImageTierId,
  type PickedImage,
  type RawImage,
} from "../imagePick";
import { theme } from "../theme";
import { Btn, Sheet } from "./ui";
import { ZoomableImage } from "./ZoomableImage";

/** 12345 → 12,345(卡片里数字要一眼看得出量级) */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 发图前问一次档位。
 *
 * ⚠️ 为什么不做成设置项:不同图该压到什么程度本来就不一样(代码截图要让模型看清字,
 * 随手拍只要看懂大意),而且真出问题时得能**一张一张地对照**。
 *
 * ⚠️ 它**完全在手机本地**,不经过服务端。服务端那套审批(`canUseTool` → permissions
 * 状态机)是"服务端发起、手机应答"的,手机没法往里塞一个本地决定 —— 也**不需要**:
 * 这张卡片只是在把手里的图交给发送流程**之前**问一句,你不点头它连压都不压。
 * 样式上复用 App 自己的模态框架(和设置页、产物预览同一个 `Sheet`)。
 *
 * ⚠️ **预览必须是"压完的样子",不能是原图。** 这是这一版改对的地方:手机屏幕上
 * 原图和压过的图都会被缩放进同一个框,肉眼几乎一样 —— 拿原图当预览等于什么都看不出。
 * 而模型读的是**原始像素**、不是手机渲染出来的样子 —— 所以预览给的是压完的那份
 * (点开还能放大看细节)。这份预览同时就是最后要发出去的那份,不是额外开销。
 */
export function ImageTierSheet({
  raw,
  current,
  preview,
  previewTier,
  busy,
  onPick,
  onConfirm,
  onCancel,
  compact = false,
  confirmLabel,
}: {
  /** 为空表示不显示。有值就是"正在问这一张" */
  raw: RawImage | null;
  /** 当前高亮的档位 */
  current: ImageTierId;
  /** 当前档位**压完**的那份(还没压出来时为 null) */
  preview: PickedImage | null;
  /** 预览对应的档位 —— 压的过程中 `current` 已经变了,标题得看着它 */
  previewTier: ImageTierId;
  busy?: boolean;
  onPick: (tier: ImageTierId) => void;
  onConfirm: () => void;
  onCancel: () => void;
  compact?: boolean;
  confirmLabel?: string;
}) {
  const base = raw ? tokenEstimateOf(raw.width, raw.height) : 0;

  return (
    <Sheet
      visible={!!raw}
      onClose={busy ? () => undefined : onCancel}
      title="图片清晰度"
      subtitle={
        raw
          ? compact ? `原图 ${raw.width}×${raw.height}` : `原图 ${raw.width}×${raw.height} · ≈${fmt(base)} token`
          : undefined
      }
    >
      {raw ? (
        <View style={styles.body}>
          {/*
            预览 = **压完的那份**,用 `ZoomableImage`(点一下能看大图)。

            ⚠️ 别改成"固定大小的死图":2026-09-20 我先这么改过一版,理由是"卡片本身是
            Modal,里面再点开一个全屏 Modal 在 Android 上不显示" —— 那是我瞎猜的,
            使用者实测**能打开**,并且明确要求"预览要有"。

            也**不必**担心四档没法比:同一张图的四档长宽比相同,按比例铺下来在屏幕上
            是同一个尺寸,压得狠的那档反而会被放大,糊在哪儿照样看得见。
          */}
          {preview ? (
            <ZoomableImage
              uri={preview.uri}
              caption={`${tierLabelOf(previewTier)} · 这一档实际 ${preview.width}×${preview.height} · 点一下看大图`}
            />
          ) : (
            <View style={styles.placeholder}>
              <ActivityIndicator size="small" color={theme.color.accent} />
              <Text style={styles.placeholderText}>正在按这一档压…</Text>
            </View>
          )}

          {IMAGE_TIERS.map((t) => {
            const size = outputSizeOf(t, raw.width, raw.height);
            const tok = tokenEstimateOf(size.width, size.height);
            const on = current === t.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => onPick(t.id)}
                disabled={busy}
                style={[styles.opt, on && styles.optOn]}
              >
                <View style={styles.optHead}>
                  <Text style={[styles.optLabel, on && styles.optLabelOn]}>{t.label}</Text>
                  <Text style={styles.optSize}>
                    {size.width}×{size.height}{compact ? "" : ` · ≈${fmt(tok)} token`}
                  </Text>
                  {on ? <Ionicons name="checkmark" size={16} color={theme.color.accent} /> : null}
                </View>
                <Text style={styles.optHint}>
                  {compact && t.id === "original" ? "最长边 1568 像素" : t.hint}
                  {!compact && base > 0 && tok < base ? ` · 是原图的 ${Math.round((100 * tok) / base)}%` : ""}
                </Text>
              </Pressable>
            );
          })}

          {/* 换档就重压一份预览,所以"选"和"发"分成两步:先看清楚,再决定 */}
          {!compact ? <Text style={styles.note}>
            上面是这一档压完的样子。四档都铺在同一块框里,所以糊了多少直接看得出来;
            换档会重新压一份。
          </Text> : null}

          <Btn
            label={confirmLabel ?? `用「${tierLabelOf(current)}」发`}
            kind="primary"
            full
            onPress={onConfirm}
            disabled={busy || !preview || previewTier !== current}
          />
          <Btn label="取消这次发图" kind="quiet" full onPress={onCancel} disabled={busy} />
        </View>
      ) : null}
    </Sheet>
  );
}

function tierLabelOf(id: ImageTierId): string {
  return IMAGE_TIERS.find((t) => t.id === id)?.label ?? id;
}

const styles = StyleSheet.create({
  body: { gap: theme.space(2) },
  placeholder: {
    height: 180,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.codeBg,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(2),
  },
  placeholderText: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  opt: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceAlt,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    gap: 2,
  },
  optOn: { borderColor: theme.color.accent, backgroundColor: theme.color.accentSoft },
  optHead: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  optLabel: { color: theme.color.text, fontSize: theme.font.size.md },
  optLabelOn: { color: theme.color.accent, fontWeight: theme.font.weight.bold },
  optSize: { color: theme.color.textDim, fontSize: theme.font.size.sm, flex: 1 },
  optHint: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  note: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 17 },
});
