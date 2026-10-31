import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/**
 * 选图 / 压图。
 *
 * ⚠️ 这里的流程是**三段**,不是一段:选原图 → (手机上弹一张卡片问档位)→ 按档压。
 * 档位**不在设置里**,而是每张图问一次 —— 不同图该压到什么程度本来就不一样(一张
 * 代码截图和一张随手拍,要求完全不同),而且真出问题时得能一张一张地对照。
 *
 * ⚠️ **省 token 只跟"像素尺寸"有关,跟文件字节数无关。** 上游的图片理解本来就把长边
 * 缩到 1568 以内,喂更大的图不会带来额外信息;而计费按面积算(`长×宽/750` token)——
 * JPEG 质量从 0.95 降到 0.6 能把体积砍一半,**token 一个不省**。所以档位之间真正的
 * 差别是 `scale`(见 ImageTier 的说明),`quality` 只影响传输和磁盘。
 *
 * 而且图是**每一轮都重发**的:落在缓存覆盖得到的前段几乎不要钱,落在覆盖不到的后段
 * 就是每轮全价重读 —— 长会话里档位的影响是"张数 × 轮数",不是加法。
 */

export type ImageTierId = "original" | "high" | "standard" | "low";

export interface ImageTier {
  id: ImageTierId;
  label: string;
  /**
   * **相对这张图自己长边的比例**(1 = 不缩,但仍受上游 1568 上限约束)。
   *
   * ⚠️ 为什么是比例而不是固定的 1568/1280/1024/768:固定值在大小图上表现不一致 ——
   * 一张 400px 的小图四档**全都不缩**(等于没得选),而 2780px 的截图四档差别很大。
   * 2026-09-20 真机上发现并改掉。
   */
  scale: number;
  /** JPEG 质量。只影响体积,不影响 token */
  quality: number;
  hint: string;
}

/** 上游的硬上限:图再大,它也只用长边 1568 以内,喂更多纯浪费带宽 */
const UPSTREAM_MAX_EDGE = 1568;

/**
 * 算出来的长边落到 32 的倍数上 —— 免得卡片里出现 1043×783 这种怪尺寸,
 * 而 8/16/32 的倍数在缩放与编码里是最不挑的。
 */
const EDGE_GRID = 32;

const TIER_ORIGINAL: ImageTier = {
  id: "original",
  label: "清晰",
  scale: 1,
  quality: 0.95,
  hint: "长边 100%(上游上限 1568 截断)",
};
const TIER_HIGH: ImageTier = {
  id: "high",
  label: "均衡",
  scale: 0.8,
  quality: 0.85,
  hint: "长边 80%",
};
const TIER_STANDARD: ImageTier = {
  id: "standard",
  label: "标准",
  scale: 0.65,
  quality: 0.8,
  hint: "长边 65%",
};
const TIER_LOW: ImageTier = {
  id: "low",
  label: "省流",
  scale: 0.5,
  quality: 0.75,
  hint: "长边 50%",
};

/**
 * 顺序即卡片里从上到下的顺序。
 *
 * ⚠️ 档位之间**只有长边真正有意义** —— 它同时决定 token(`长×宽/750`,按面积)和
 * "模型还认不认得出字";质量只影响隧道体积和磁盘。
 *
 * 比例是 2026-09-20 真机实测定的:640 那档"啥都看不清楚"、1024 "挺好",于是定
 * 1 / 0.8 / 0.65 / 0.5 —— 对一张 2780px 的截图就是 1568(1248)1024 768。
 */
export const IMAGE_TIERS: ImageTier[] = [TIER_ORIGINAL, TIER_HIGH, TIER_STANDARD, TIER_LOW];

export const DEFAULT_IMAGE_TIER: ImageTierId = "standard";

/** 认不出来的 id(老版本残留、手改过)一律退回默认档,不要让选图直接失败 */
export function tierOf(id: string | null | undefined): ImageTier {
  return IMAGE_TIERS.find((t) => t.id === id) ?? TIER_STANDARD;
}

/**
 * 这一档实际会把长边压到多少 —— 基数取**这张图自己的长边**(先按上游上限截到 1568),
 * 乘档位比例,再落到最近的 32 的倍数上。**永远不放大**。
 *
 * 卡片要在压之前就把代价摆出来,`compressImage` 也必须用同一个值,所以它单独一个函数。
 */
export function targetEdgeOf(tier: ImageTier, width: number, height: number): number {
  const base = Math.min(Math.max(width, height), UPSTREAM_MAX_EDGE);
  // 比例 1 的那档原样不动 —— 网格只在"要缩"的时候才有意义,否则 200px 的小图会被
  // "对齐"成 192(等于偷偷缩了一刀,而它写着"原图")
  if (tier.scale >= 1) return base;
  const snapped = Math.max(EDGE_GRID, Math.round((base * tier.scale) / EDGE_GRID) * EDGE_GRID);
  return Math.min(base, snapped);
}

/** 选完档位后**会**压成多大(与 `compressImage` 同一套算法,差一两个像素无所谓) */
export function outputSizeOf(tier: ImageTier, width: number, height: number): {
  width: number;
  height: number;
} {
  const longest = Math.max(width, height);
  const target = targetEdgeOf(tier, width, height);
  if (target >= longest) return { width, height };
  const k = target / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

/** 上游的图片计费口径:按面积折算 token */
export function tokenEstimateOf(width: number, height: number): number {
  return Math.round((width * height) / 750);
}

/** Messages API 的单图上限是 5MB,留一点余量 */
const MAX_BYTES = 4 * 1024 * 1024;

/** 刚从相册选出来的原图。还没压,等使用者定了档位再压 */
export interface RawImage {
  uri: string;
  width: number;
  height: number;
}

export interface PickedImage {
  /**
   * 手机本地 URI。只用来**立刻回显** —— 这一刻服务端还没有这张图,
   * 历史回放时会换成带服务端路径的同一条消息块。
   */
  uri: string;
  mediaType: string;
  /** 裸 base64,不带 `data:` 前缀 */
  data: string;
  size: number;
  /** 压完的实际像素尺寸与体积 —— 显示在缩略图下面,好和"模型认不认得出"对账 */
  width: number;
  height: number;
  /** 原图 URI 与尺寸:**改了档位要能重压**,所以原图那一路必须留着 */
  originalUri: string;
  originalWidth: number;
  originalHeight: number;
  /** 用的哪一档 */
  tier: ImageTierId;
}

export type PickOutcome =
  | { kind: "ok"; image: PickedImage }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export type RawOutcome =
  | { kind: "ok"; raw: RawImage }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

/** base64 字符串解出来大约多少字节(含 padding 的估算,够用来卡上限) */
function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

/** 第一步:只要原图,不压 */
export async function pickRawImage(): Promise<RawOutcome> {
  let picked: ImagePicker.ImagePickerResult;
  try {
    picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      // 不在这里压:此时分辨率还没降,先拿原图,再统一走一次处理
      quality: 1,
      exif: false,
    });
  } catch (err) {
    return { kind: "error", message: `打不开相册:${String(err)}` };
  }

  if (picked.canceled) return { kind: "cancelled" };
  const asset = picked.assets?.[0];
  if (!asset) return { kind: "cancelled" };

  return { kind: "ok", raw: { uri: asset.uri, width: asset.width, height: asset.height } };
}

/** 第三步:按定下来的档位压 */
export async function compressImage(raw: RawImage, tier: ImageTier): Promise<PickOutcome> {
  const { uri, width, height } = raw;
  try {
    const ctx = ImageManipulator.manipulate(uri);

    // 只给长边,另一边由它按比例算 —— 自己算容易在极端比例上差一两个像素。
    // 这个 target 与卡片预览用的是同一个函数,不会出现"预览说 1024、实际压成别的"。
    const longest = Math.max(width, height);
    const target = targetEdgeOf(tier, width, height);
    if (target < longest) {
      if (width >= height) ctx.resize({ width: target });
      else ctx.resize({ height: target });
    }

    const ref = await ctx.renderAsync();
    // 统一转 JPEG:PNG 截图体积大得多,而这类内容用 JPEG 完全够看
    const out = await ref.saveAsync({
      compress: tier.quality,
      format: SaveFormat.JPEG,
      base64: true,
    });

    if (!out.base64) return { kind: "error", message: "图片编码失败" };

    const size = base64Bytes(out.base64);
    if (size > MAX_BYTES) {
      return {
        kind: "error",
        message: `压完仍有 ${(size / 1024 / 1024).toFixed(1)}MB,超过单张上限`,
      };
    }

    return {
      kind: "ok",
      image: {
        uri: out.uri,
        mediaType: "image/jpeg",
        data: out.base64,
        size,
        width: ref.width,
        height: ref.height,
        originalUri: uri,
        originalWidth: width,
        originalHeight: height,
        tier: tier.id,
      },
    };
  } catch (err) {
    return { kind: "error", message: `处理图片失败:${String(err)}` };
  }
}
