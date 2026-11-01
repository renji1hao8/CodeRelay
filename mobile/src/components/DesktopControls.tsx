import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Api } from "../api";
import type { DesktopAction, DesktopControl, DesktopProvider } from "../shared";
import { Btn, Sheet } from "./ui";
import { theme } from "../theme";
import { toolIntent } from "../toolIntent";
import { errText } from "../util";

export function DesktopControls({ api, provider, id, onChanged }: { api: Api; provider: DesktopProvider; id: string; onChanged: () => void }) {
  const [control, setControl] = useState<DesktopControl | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null), [output, setOutput] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const mounted = useRef(true), reading = useRef(false);
  const submitted = useRef(new Set<string>());
  const waiting = useRef<DesktopAction | null>(null);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await api.desktopControl(provider, id);
      if (mounted.current) {
        setControl(next);
        const action = waiting.current;
        if (next.connected && action) {
          const resolved = action.type === "approval" ? !next.approvals.some(a => a.id === action.requestId)
            : action.type === "stopTask" ? next.tasksKnown && !next.tasks.some(t => t.id === action.taskId && t.canStop)
            : next.turnKey !== action.turnKey;
          if (resolved) { waiting.current = null; setNotice(action.type === "approval" ? "审批已由电脑处理" : action.type === "stopTask" ? "任务已结束" : "上一轮回复已结束"); }
        }
      }
    }
    catch (e) { if (mounted.current) setNotice(errText(e)); }
    finally { reading.current = false; }
  }, [api, provider, id]);
  useEffect(() => {
    mounted.current = true; let stopped = false, active = AppState.currentState === "active";
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (active) await refresh(); if (!stopped) timer = setTimeout(() => void poll(), 3000); };
    void poll();
    const sub = AppState.addEventListener("change", value => { active = value === "active"; if (active) void refresh(); });
    return () => { mounted.current = false; stopped = true; clearTimeout(timer); sub.remove(); };
  }, [refresh]);
  const act = async (action: DesktopAction) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    const actionId = action.type === "approval" ? action.requestId : action.type === "stopTask" ? action.taskId : action.turnKey;
    submitted.current.add(actionId);
    waiting.current = action;
    try { const result = await api.desktopAction(provider, id, action); if (mounted.current) setNotice(result.notice); onChanged(); }
    catch (e) { waiting.current = null; submitted.current.delete(actionId); if (mounted.current) setNotice(errText(e)); }
    finally { if (mounted.current) setBusy(false); void refresh(); }
  };
  const readOutput = async (taskId: string) => {
    setBusy(true);
    try { const result = await api.desktopTaskOutput(provider, id, taskId); setOutput(result.output || "暂时没有输出"); }
    catch (e) { setNotice(errText(e)); } finally { setBusy(false); }
  };
  const approvals = control?.approvals ?? [], tasks = control?.tasks ?? [];
  const running = tasks.filter(t => t.canStop).length;
  return <View>
    <View style={s.toolbar}>
      <Pressable accessibilityRole="button" style={s.entry} onPress={() => { setOpen(true); void refresh(); }}><Text style={s.entryText}>{provider === "claude" ? `后台任务${running ? ` · ${running}` : ""}` : "会话控制"}{approvals.length ? ` · ${approvals.length} 项待审批` : ""}</Text></Pressable>
      {control?.canInterrupt && control.turnKey ? <Btn label={submitted.current.has(control.turnKey) ? "正在停止" : "停止回复"} kind="danger" small disabled={busy || submitted.current.has(control.turnKey)} onPress={() => void act({ type: "interrupt", turnKey: control.turnKey! })} /> : null}
    </View>
    {approvals.length ? <Pressable style={s.banner} onPress={() => setOpen(true)}><Text style={s.bannerText}>有 {approvals.length} 项操作等待你批准 · 点击处理</Text></Pressable> : null}
    {control && !control.connected ? <Text style={s.hint}>电脑控制未连接，审批暂不能同步。请用“{provider} 手机控制”快捷方式重开桌面端。</Text> : null}
    {notice && !open ? <Text style={s.hint}>{notice}</Text> : null}
    <Sheet visible={open} title="会话控制" onClose={() => { setOpen(false); setOutput(null); }}>
      <ScrollView style={s.scroll} contentContainerStyle={s.stack} nestedScrollEnabled>
        {!control?.connected ? <Text style={s.hint}>{control?.notice || "正在连接电脑…"}。请在电脑上使用“手机控制”快捷方式打开桌面应用。</Text> : null}
        {control?.notice && control.connected ? <Text style={s.hint}>{control.notice}</Text> : null}
        {approvals.map(approval => {
          const intent = toolIntent(approval.tool, approval.input);
          return <View key={approval.id} style={s.card}>
            <Text style={s.title}>等待批准 · {intent.headline}</Text>
            {approval.description || intent.description ? <Text style={s.text}>{approval.description || intent.description}</Text> : null}
            <Pressable onPress={() => setInspect(old => old === approval.id ? null : approval.id)}><Text numberOfLines={inspect === approval.id ? undefined : 4} selectable style={s.code}>{intent.detail || JSON.stringify(approval.input, null, 2)}</Text><Text style={s.hint}>{inspect === approval.id ? "收起详情" : "查看完整参数"}</Text></Pressable>
            {!approval.canAllow ? <Text style={s.hint}>这项操作需在电脑上批准，可在手机上拒绝。</Text> : null}
            <View style={s.actions}><Btn label="拒绝" kind="danger" small disabled={busy || submitted.current.has(approval.id)} onPress={() => void act({ type: "approval", requestId: approval.id, decision: "deny" })} /><Btn label={submitted.current.has(approval.id) ? "等待电脑确认" : "允许一次"} kind="ok" small disabled={busy || !approval.canAllow || submitted.current.has(approval.id)} onPress={() => void act({ type: "approval", requestId: approval.id, decision: "allow" })} /></View>
          </View>;
        })}
        {provider === "claude" ? <Text style={s.title}>后台任务{running ? ` · ${running} 个运行中` : ""}</Text> : null}
        {provider === "claude" && !tasks.length ? <Text style={s.hint}>{control?.connected && control.tasksKnown ? "当前没有后台任务" : "等待电脑同步任务状态"}</Text> : null}
        {tasks.map(task => <View key={task.id} style={s.card}><Text style={s.text}>{task.description}</Text><Text style={s.hint}>{task.canStop ? "运行中" : task.status === "completed" ? "已完成" : task.status === "failed" ? "失败" : "已结束"}</Text>{task.summary ? <Text style={s.hint}>{task.summary}</Text> : null}<View style={s.actions}><Btn label="查看输出" kind="ghost" small disabled={busy} onPress={() => void readOutput(task.id)} />{task.canStop ? <Btn label="停止此任务" kind="danger" small disabled={busy} onPress={() => void act({ type: "stopTask", taskId: task.id })} /> : null}</View></View>)}
        {output !== null ? <Text selectable style={s.code}>{output}</Text> : null}
        {notice ? <Text style={s.hint}>{notice}</Text> : null}
        <Btn label={busy ? "正在处理…" : "刷新状态"} kind="ghost" disabled={busy} onPress={() => void refresh()} />
      </ScrollView>
    </Sheet>
  </View>;
}
const s = StyleSheet.create({
  toolbar: { paddingHorizontal: theme.gutter, paddingBottom: theme.space(2), flexDirection: "row", alignItems: "center", gap: theme.space(2) }, entry: { flex: 1, paddingVertical: theme.space(2) }, entryText: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  banner: { marginHorizontal: theme.gutter, marginBottom: theme.space(2), backgroundColor: theme.color.warnSoft, padding: theme.space(3), borderRadius: theme.radius.md }, bannerText: { color: theme.color.warn, fontSize: theme.font.size.sm },
  scroll: { maxHeight: 520 }, stack: { gap: theme.space(3), paddingBottom: theme.space(4) }, card: { backgroundColor: theme.color.surfaceAlt, borderRadius: theme.radius.md, padding: theme.space(3), gap: theme.space(2) },
  title: { fontSize: theme.font.size.sm, fontWeight: "600", color: theme.color.text }, text: { color: theme.color.text, fontSize: theme.font.size.md, lineHeight: 23 }, hint: { color: theme.color.textDim, fontSize: theme.font.size.xs, lineHeight: 19 }, code: { color: theme.color.codeText, backgroundColor: theme.color.codeBg, padding: theme.space(3), borderRadius: theme.radius.sm, fontSize: theme.font.size.xs, fontFamily: theme.font.mono, lineHeight: 20 }, actions: { flexDirection: "row", gap: theme.space(2) },
});
