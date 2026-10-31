import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ArtifactDetail, ArtifactSummary } from "../shared";
import { theme, kindMeta } from "../theme";
import { PREVIEW_CHARS } from "../limits";
import { baseName, withAlpha } from "../util";
import { Badge, ListRow, formatSize, formatTime } from "./ui";

/**
 * 一块补丁,按行上色。
 *
 * ⚠️ **两种前缀都要认**(2026-09-28)。Claude 那边产出的补丁行是 `+ 内容` / `- 内容`
 * (标记后面**有**空格),而 Codex 的 `fileChange` 给的是**标准 unified diff** ——
 * `+    76: "…"`(标记后面**直接就是内容**,没有空格)。
 * 只认前一种的话,Codex 那半边的补丁会**整块是灰的**:不报错、也不难看,
 * 只是"改了哪几行"这件最要紧的事看不出来。
 *
 * `+++` / `---` 那两个文件头行要排除掉,否则它们会被整行涂成绿/红。
 */
function lineTone(line: string): "add" | "del" | null {
  if (line.startsWith("+++") || line.startsWith("---")) return null;
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return null;
}

export function DiffView({ diff }: { diff: string }) {
  return (
    <View style={styles.diffBox}>
      {diff.split("\n").map((line, i) => {
        const tone = lineTone(line);
        return (
          <Text
            key={i}
            style={[
              styles.diffLine,
              tone === "add" && { backgroundColor: theme.color.diffAdd, color: theme.color.diffAddText },
              tone === "del" && { backgroundColor: theme.color.diffDel, color: theme.color.diffDelText },
            ]}
          >
            {line}
          </Text>
        );
      })}
    </View>
  );
}

export function ArtifactCard({
  artifact,
  onPress,
}: {
  artifact: ArtifactSummary;
  onPress: () => void;
}) {
  const meta = kindMeta[artifact.kind] ?? {
    label: artifact.kind,
    color: theme.color.textDim,
    icon: "document-outline",
  };
  const name = baseName(artifact.path) || artifact.path;
  const dir = artifact.path.slice(0, artifact.path.length - name.length).replace(/[\\/]$/, "");

  return (
    <ListRow
      icon={meta.icon as never}
      iconColor={meta.color}
      iconBg={withAlpha(meta.color, 0.08)}
      title={name}
      subtitle={`${meta.label} · ${formatSize(artifact.size)} · ${formatTime(artifact.createdAt)}${dir ? ` · ${dir}` : ""}`}
      onPress={onPress}
      right={<Ionicons name="chevron-forward" size={16} color={theme.color.textFaint} />}
    />
  );
}

export function ArtifactPreview({
  detail,
  imageUrl,
}: {
  detail: ArtifactDetail;
  imageUrl: string | null;
}) {
  const meta = kindMeta[detail.kind] ?? { label: detail.kind, color: theme.color.textDim };
  return (
    <View>
      <View style={styles.head}>
        <Badge text={meta.label} color={meta.color} />
        <Text style={styles.size}>{formatSize(detail.size)}</Text>
      </View>
      <Text style={styles.fullPath} selectable>
        {detail.path}
      </Text>

      {detail.diff ? (
        <View style={{ marginTop: theme.space(3) }}>
          <Text style={styles.section}>改动内容</Text>
          <DiffView diff={detail.diff} />
        </View>
      ) : null}

      {detail.kind === "image" && imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.image} resizeMode="contain" />
      ) : null}

      {detail.content ? (
        <View style={{ marginTop: theme.space(3) }}>
          <Text style={styles.section}>文件内容</Text>
          <Text style={styles.content} selectable>
            {detail.content.length > PREVIEW_CHARS
              ? `${detail.content.slice(0, PREVIEW_CHARS)}\n… 已截断`
              : detail.content}
          </Text>
        </View>
      ) : null}

      {!detail.content && !detail.diff && detail.kind !== "image" ? (
        <Text style={styles.hint}>这个文件没有可预览的文本内容,可以用下面的按钮下载到手机。</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: theme.space(2) },
  fullPath: { color: theme.color.textDim, fontFamily: theme.font.mono, fontSize: theme.font.size.xs, marginBottom: theme.space(2) },
  size: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  section: { color: theme.color.textDim, fontSize: theme.font.size.xs, fontWeight: "700", marginBottom: theme.space(2) },
  diffBox: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(2),
  },
  diffLine: {
    color: theme.color.textDim,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    lineHeight: 18,
  },
  image: { width: "100%", height: 260, marginTop: theme.space(3), backgroundColor: theme.color.codeBg, borderRadius: theme.radius.md },
  content: {
    // 用主题的 codeText 而不是另找一个冷蓝 —— 整个暖色体系刻意不收冷色,
    // 原先这里和 FilesScreen 各写了一遍 #cfe3ff,在暖底上是两块突兀的补丁
    color: theme.color.codeText,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    lineHeight: 18,
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    padding: theme.space(3),
  },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.sm, marginTop: theme.space(3), lineHeight: 20 },
});
