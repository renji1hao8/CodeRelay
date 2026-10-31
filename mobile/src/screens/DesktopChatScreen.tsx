import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import type { Api } from "../api";
import type { ChatMessage, DesktopDetail, DesktopSession } from "../shared";
import { MessageBubble, messageText } from "../components/MessageBubble";
import { ToolGroup, groupMessages, groupTurns, type Turn } from "../components/ToolGroup";
import { IconButton, Sheet, Btn } from "../components/ui";
import { peek, put } from "../cache";
import { mergeDesktopMessages, confirmsDesktopPending, withDesktopPending, findDesktopReceipt } from "../desktopState";
import { useKeyboardHeight } from "../useKeyboardHeight";
import { theme } from "../theme";
import { errText } from "../util";
import { DesktopControls } from "../components/DesktopControls";
import { ImageTierSheet } from "../components/ImageTierSheet";
import { pickRawImage, compressImage, tierOf, DEFAULT_IMAGE_TIER, type RawImage, type PickedImage, type ImageTierId } from "../imagePick";
import { presentUserMessage } from "../shared";
import { formatSize } from "../components/ui";

interface DraftAttachment { path: string; name: string; size: number; mimeType: string; previewUri?: string; dimensions?: string }
interface Pending { requestId: string; text: string; status: "sending" | "submitted" | "unknown"; at: string }
const newId = () => `mobile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

/** Both providers use the exact same chat layout and native-session lifecycle. */
export function DesktopChatScreen({ api, initial, onBack }: { api: Api; initial: DesktopSession; onBack: () => void }) {
  const legacyKey = api.cacheKey(`desktop:${initial.provider}:${initial.id}`);
  const key = api.cacheKey(`desktop-v2:${initial.provider}:${initial.id}`);
  const saved = peek<DesktopDetail>(key);
  const [session, setSession] = useState(saved?.session ?? initial);
  const [messages, setMessages] = useState<ChatMessage[]>(saved?.messages ?? []);
  const [cursor, setCursor] = useState<string | null>(saved?.olderCursor ?? null);
  const [loading, setLoading] = useState(!saved);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => peek<string>(key + ":draft") ?? peek<string>(legacyKey + ":draft") ?? "");
  const [pending, setPending] = useState<Pending | null>(() => peek<Pending>(key + ":pending") ?? peek<Pending>(legacyKey + ":pending"));
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<DraftAttachment[]>(() => peek<DraftAttachment[]>(key + ":attachments") ?? []);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [rawImage, setRawImage] = useState<RawImage | null>(null);
  const [imageTier, setImageTier] = useState<ImageTierId>(DEFAULT_IMAGE_TIER);
  const [imagePreview, setImagePreview] = useState<PickedImage | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [checking, setChecking] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [copy, setCopy] = useState<ChatMessage | null>(null);
  const [jump, setJump] = useState(false);
  const list = useRef<FlatList<Turn>>(null), atBottom = useRef(true), scrolled = useRef(false);
  const loadedOlder = useRef(false), flight = useRef(false), mounted = useRef(true);
  const phase = useRef(session.status);
  phase.current = session.status;
  const insets = useSafeAreaInsets(), keyboardHeight = useKeyboardHeight(), keyboardUp = keyboardHeight > 0;
  useEffect(() => { put(key + ":draft", draft); }, [key, draft]);
  useEffect(() => { put(key + ":attachments", attachments); }, [key, attachments]);
  useEffect(() => {
    if (!rawImage) { setImagePreview(null); setCompressing(false); return; }
    let current = true;
    setImagePreview(null); setCompressing(true);
    void compressImage(rawImage, tierOf(imageTier)).then(result => {
      if (!current) return;
      setCompressing(false);
      if (result.kind === "ok") setImagePreview(result.image);
      else if (result.kind === "error") { setError(result.message); setRawImage(null); }
    });
    return () => { current = false; };
  }, [rawImage, imageTier]);
  useEffect(() => { put(key + ":pending", pending); put(legacyKey + ":pending", null); }, [key, legacyKey, pending]);
  const read = useCallback(async () => {
    if (flight.current) return;
    flight.current = true;
    try {
      const detail = await api.desktopDetail(initial.provider, initial.id);
      if (!mounted.current) return;
      setSession(detail.session); setError(null);
      setMessages(old => {
        const next = mergeDesktopMessages(old, detail.messages);
        put(key, { ...detail, messages: next, olderCursor: loadedOlder.current ? peek<DesktopDetail>(key)?.olderCursor ?? null : detail.olderCursor });
        return next;
      });
      if (!loadedOlder.current) setCursor(detail.olderCursor);
      setPending(old => old && confirmsDesktopPending(detail.messages, old) ? null : old);
    } catch (e) { if (mounted.current) setError(errText(e)); }
    finally { flight.current = false; if (mounted.current) setLoading(false); }
  }, [api, initial.provider, initial.id, key]);
  useEffect(() => {
    mounted.current = true;
    let active = AppState.currentState === "active", stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (active) await read();
      if (!stopped) timer = setTimeout(() => void poll(), phase.current === "busy" ? 900 : 2500);
    };
    void poll();
    const sub = AppState.addEventListener("change", state => { active = state === "active"; if (active) void read(); });
    return () => { mounted.current = false; stopped = true; clearTimeout(timer); sub.remove(); };
  }, [read]);
  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const detail = await api.desktopDetail(initial.provider, initial.id, cursor);
      loadedOlder.current = true;
      setMessages(old => { const next = mergeDesktopMessages(old, detail.messages, true); put(key, { ...detail, messages: next }); return next; });
      setCursor(detail.olderCursor);
    } catch (e) { setError(errText(e)); } finally { setLoadingOlder(false); }
  };
  const openDesktop = async () => {
    if (opening) return;
    setOpening(true); setError(null);
    try { const result = await api.desktopOpen(initial.provider, initial.id); setSession(result.session); void read(); }
    catch (e) { setError(errText(e)); } finally { setOpening(false); }
  };
  const send = async (retry?: Pending) => {
    const text = retry?.text ?? [draft.trim(), ...attachments.map(file => `@${file.path}`)].filter(Boolean).join("\n\n");
    if (!text || posting || uploading || (!retry && pending)) return;
    if (text.length > 16000) { setError("消息太长，请缩短文字或分开发送附件"); return; }
    const message: Pending = retry ?? { requestId: newId(), text, status: "sending", at: new Date().toISOString() };
    setPosting(true); setPending(message); setError(null); setReceipt(null);
    if (!retry) { setDraft(""); setAttachments([]); }
    atBottom.current = true;
    try {
      const result = await api.desktopSend(initial.provider, initial.id, text, message.requestId);
      setPending(old => old?.requestId === message.requestId ? { ...message, at: result.acceptedAt ?? message.at, status: result.status } : old);
      if (result.status === "unknown") setError(result.notice);
      void read();
    } catch (e) {
      // The POST might already have reached Desktop. Retain its exact id/text;
      // checking again uses the same id and the durable server ledger.
      setPending(old => old?.requestId === message.requestId ? { ...message, status: "unknown" } : old); setError(errText(e));
    } finally { setPosting(false); }
  };
  const verifyDelivery = async () => {
    if (!pending || checking || posting) return;
    const target = pending;
    setChecking(true); setReceipt(null); setError(null);
    try {
      // This is deliberately read-only: a receipt check never calls send.
      const detail = await api.desktopDetail(initial.provider, initial.id);
      const observed = await findDesktopReceipt(detail, target, cursor => api.desktopDetail(initial.provider, initial.id, cursor));
      setMessages(old => mergeDesktopMessages(old, observed.messages)); setSession(detail.session);
      if (observed.received) {
        setPending(old => old?.requestId === target.requestId ? null : old);
        setReceipt("已核实，桌面会话已收到");
      } else setReceipt("暂未在桌面历史中找到这条消息，会继续同步");
    } catch (e) { setError(errText(e)); } finally { setChecking(false); }
  };
  const uploadAttachment = async (file: { uri: string; name: string; mimeType: string }, dimensions?: string) => {
    setUploading(true); setError(null);
    try {
      const uploaded = await api.attach(file);
      const stored = uploaded.files[0];
      if (!stored) throw new Error("附件上传未返回文件路径");
      setAttachments(old => [...old, { ...stored, mimeType: file.mimeType, ...(file.mimeType.startsWith("image/") ? { previewUri: file.uri } : {}), dimensions }]);
      return true;
    } catch (e) { setError(errText(e)); return false; } finally { setUploading(false); }
  };
  const pickImage = async () => {
    setAttachmentMenu(false);
    if (uploading) return;
    setUploading(true); setError(null);
    try {
      const result = await pickRawImage();
      if (result.kind === "ok") setRawImage(result.raw);
      else if (result.kind === "error") setError(result.message);
    } finally { setUploading(false); }
  };
  const confirmImage = async () => {
    if (!imagePreview || compressing || uploading || imagePreview.tier !== imageTier) return;
    const image = imagePreview;
    if (await uploadAttachment({ uri: image.uri, name: `image-${Date.now()}.jpg`, mimeType: image.mediaType }, `${image.width}×${image.height}`)) setRawImage(null);
  };
  const attach = async () => {
    setAttachmentMenu(false);
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets[0]) return;
    const file = result.assets[0];
    await uploadAttachment({ uri: file.uri, name: file.name, mimeType: file.mimeType ?? "application/octet-stream" });
  };
  useEffect(() => {
    if (pending && pending.status !== "sending") void verifyDelivery();
  }, [pending?.requestId, pending?.status]);
  const shown = useMemo(() => withDesktopPending(messages, pending).map(presentUserMessage), [messages, pending]);
  const turns = useMemo(() => groupTurns(groupMessages(shown)), [shown]);
  const latestTools = useMemo(() => {
    const turn = turns.at(-1);
    const item = turn?.kind === "assistant" ? turn.items.at(-1) : undefined;
    return item?.kind === "tools" ? item.key : undefined;
  }, [turns]);
  return <View style={styles.root}>
    <View style={styles.header}>
      <IconButton icon="chevron-back" onPress={onBack} size={22} />
      <View style={styles.heading}><Text style={styles.title} numberOfLines={1}>{session.title}</Text>
        <View style={styles.statusRow}><View style={[styles.dot, { backgroundColor: session.status === "offline" ? theme.color.textFaint : error ? theme.color.warn : theme.color.ok }]} />
          <Text style={styles.sub}>{initial.provider === "codex" ? "Codex" : "Claude"} · {loading ? "读取中" : session.status === "busy" ? "正在运行" : session.status === "offline" ? "未打开" : "已连接"}</Text></View>
      </View><IconButton icon="refresh-outline" label="刷新会话" onPress={() => void read()} />
    </View>
    <DesktopControls api={api} provider={initial.provider} id={initial.id} onChanged={() => void read()} />
    {initial.provider === "claude" && !session.canSend ? <View style={styles.pending}><Btn label={opening ? "正在打开桌面会话…" : "打开并继续"} disabled={opening} onPress={() => void openDesktop()} /></View> : null}
    {session.notice ? <Text style={styles.hint}>{session.notice}</Text> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <View style={styles.listWrap}><FlatList ref={list} data={turns} keyExtractor={t => t.key}
      renderItem={({ item }) => item.kind === "user" ? <MessageBubble message={item.message} onLongPress={() => setCopy(item.message)} /> :
        <View style={styles.turnWrap}><View style={styles.turnBox}>{item.items.map(it => it.kind === "message" ? <MessageBubble key={it.key} message={it.message} bare onLongPress={() => setCopy(it.message)} /> : <ToolGroup key={it.key} entries={it.entries} bare live={session.status === "busy" && it.key === latestTools} />)}</View></View>}
      ListHeaderComponent={cursor ? <Pressable style={styles.older} onPress={() => void loadOlder()} disabled={loadingOlder}><Text style={styles.accent}>{loadingOlder ? "正在加载…" : "加载更早的消息"}</Text></Pressable> : undefined}
      ListEmptyComponent={loading ? <ActivityIndicator color={theme.color.accent} /> : <Text style={styles.hint}>{error ? "消息暂时无法加载，点击右上角重试" : "这条会话还没有消息"}</Text>}
      contentContainerStyle={styles.content} maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScrollBeginDrag={() => { scrolled.current = true; }} scrollEventThrottle={32}
      onScroll={({ nativeEvent: e }) => { if (!scrolled.current) return; atBottom.current = e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y < 80; setJump(!atBottom.current); }}
      onContentSizeChange={() => { if (atBottom.current) list.current?.scrollToEnd({ animated: false }); }} />
      {jump ? <Pressable style={styles.jump} onPress={() => { atBottom.current = true; setJump(false); list.current?.scrollToEnd({ animated: true }); }}><Text style={styles.jumpText}>↓</Text></Pressable> : null}
    </View>
    {receipt ? <Text style={styles.hint}>{receipt}</Text> : null}
    {pending ? <View style={styles.pending}><Text style={styles.sub}>{pending.status === "sending" ? "正在投递…" : pending.status === "submitted" ? "已送到桌面，正在同步记录" : "投递结果待核实"}</Text>
      <View style={styles.actions}><Btn label={checking ? "正在核实…" : "核实投递"} onPress={() => void verifyDelivery()} disabled={posting || checking} small />
        {pending.status === "unknown" ? <Btn label="取回草稿" onPress={() => { setDraft(pending.text); setPending(null); }} disabled={posting || checking} small /> : null}</View>
    </View> : null}
    {uploading ? <Text style={styles.hint}>正在上传附件…</Text> : null}
    {attachments.length ? <ScrollView horizontal style={styles.attachmentStrip} contentContainerStyle={styles.attachmentContent} keyboardShouldPersistTaps="handled">{attachments.map((file, index) => <View key={file.path} style={styles.attachment}>
      {file.previewUri ? <Image source={{ uri: file.previewUri }} style={styles.thumbnail} resizeMode="cover" /> : null}
      <View style={styles.attachmentInfo}><Text style={styles.fileName} numberOfLines={1}>{file.name}</Text><Text style={styles.sub}>{[file.dimensions, formatSize(file.size)].filter(Boolean).join(" · ")}</Text></View>
      <IconButton icon="close" label={`移除 ${file.name}`} size={15} onPress={() => setAttachments(old => old.filter((_, i) => i !== index))} disabled={posting} />
    </View>)}</ScrollView> : null}
    <View style={[styles.composer, { paddingBottom: keyboardUp ? theme.space(2) : Math.max(insets.bottom, theme.space(3)) }]}>
      <IconButton icon="add" label="添加图片或文件" onPress={() => setAttachmentMenu(true)} disabled={uploading || posting || attachments.length >= 8} />
      <TextInput style={styles.input} value={draft} onChangeText={setDraft} multiline placeholder={session.canSend ? "发送消息…" : "可先写草稿，打开桌面会话后发送"} placeholderTextColor={theme.color.textFaint} />
      <IconButton icon="arrow-up" label="发送到桌面" onPress={() => void send()} disabled={(!draft.trim() && !attachments.length) || !session.canSend || posting || uploading || !!pending} color={theme.color.accent} />
    </View>
    <Sheet visible={!!copy} title="消息" onClose={() => setCopy(null)}>{copy ? <Btn label="复制文字" onPress={() => { void Clipboard.setStringAsync(messageText(copy)); setCopy(null); }} /> : null}</Sheet>
    <Sheet visible={attachmentMenu} title="添加附件" onClose={() => setAttachmentMenu(false)}><Btn label="选择图片" onPress={() => void pickImage()} full /><Btn label="选择文件" onPress={() => void attach()} kind="quiet" full /></Sheet>
    <ImageTierSheet raw={rawImage} current={imageTier} preview={imagePreview} previewTier={imagePreview?.tier ?? imageTier} busy={compressing || uploading} onPick={setImageTier} onConfirm={() => void confirmImage()} onCancel={() => setRawImage(null)} compact confirmLabel={uploading ? "正在添加…" : "添加图片"} />
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg }, header: { flexDirection: "row", alignItems: "center", gap: theme.space(2), paddingHorizontal: theme.gutter, paddingVertical: theme.space(3) },
  heading: { flex: 1 }, title: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: "600" }, statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 }, dot: { width: 6, height: 6, borderRadius: 3 }, sub: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  hint: { color: theme.color.textDim, fontSize: theme.font.size.xs, paddingHorizontal: theme.gutter, paddingVertical: theme.space(2) }, error: { color: theme.color.danger, backgroundColor: theme.color.dangerSoft, padding: theme.space(3), marginHorizontal: theme.gutter, borderRadius: theme.radius.md },
  listWrap: { flex: 1 }, content: { paddingTop: theme.space(2), paddingBottom: theme.space(4) }, turnWrap: { paddingHorizontal: theme.space(3), marginBottom: theme.space(3) }, turnBox: { backgroundColor: theme.color.assistantBubble, borderRadius: theme.radius.lg, padding: theme.space(3), gap: theme.space(2) },
  older: { padding: theme.space(4), alignItems: "center" }, accent: { color: theme.color.accent }, jump: { position: "absolute", right: theme.gutter, bottom: theme.space(4), borderRadius: 18, width: 36, height: 36, backgroundColor: theme.color.accent, alignItems: "center", justifyContent: "center" }, jumpText: { color: theme.color.onAccent, fontSize: 22 },
  pending: { paddingHorizontal: theme.gutter, paddingVertical: theme.space(2), gap: theme.space(2) }, actions: { flexDirection: "row", gap: theme.space(2) },
  attachmentStrip: { maxHeight: 88, flexGrow: 0 }, attachmentContent: { paddingHorizontal: theme.gutter, gap: theme.space(2), paddingVertical: theme.space(2) }, attachment: { flexDirection: "row", alignItems: "center", gap: theme.space(2), backgroundColor: theme.color.surfaceAlt, borderRadius: theme.radius.md, padding: theme.space(2), maxWidth: 270 }, thumbnail: { width: 44, height: 44, borderRadius: theme.radius.xs }, attachmentInfo: { flexShrink: 1, gap: theme.space(1) }, fileName: { color: theme.color.text, fontSize: theme.font.size.sm },
  composer: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: theme.space(3), paddingTop: theme.space(2), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border, gap: theme.space(2) }, input: { flex: 1, minHeight: 42, maxHeight: 150, color: theme.color.text, backgroundColor: theme.color.surfaceAlt, borderRadius: theme.radius.md, paddingHorizontal: theme.space(3), paddingVertical: theme.space(2), fontSize: theme.font.size.md },
});
