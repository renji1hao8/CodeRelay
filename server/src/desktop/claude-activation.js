(() => {
  if (globalThis.__remoteccClaudeActivation?.version === 2) return;
  const api = globalThis['claude.web'].LocalSessions;
  const flights = new Map();
  const normal = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const idsOf = messages => new Set((messages || []).map(m => m.uuid).filter(v => typeof v === 'string'));
  const matches = (messages, identity) => {
    const ids = idsOf(messages);
    return identity.uuids.length >= 2 && identity.uuids.slice(-2).every(id => ids.has(id));
  };
  const refuse = reason => {
    const text = String(reason || '').toLowerCase();
    throw new Error(/trust/.test(text) ? '请先在电脑上确认此项目的工作目录信任' : /running|liveness/.test(text) ? '这条会话仍被其他进程占用，请先结束重复实例' : /folder|directory/.test(text) ? '这条会话的工作目录不存在' : '桌面暂时无法恢复此会话，请在电脑上检查项目与会话状态');
  };
  async function verify(hostId, identity, registeredHostId) {
    // Native resumeCliSession adopts a CLI transcript under local_<cliId>.
    // A fork can retain all original UUIDs; matching shared history alone does
    // not authorize targeting its different Desktop session.
    // A running Desktop session may use a host ID different from its CLI
    // transcript ID. Only the process-verified native registry can supply it.
    if (hostId !== (registeredHostId ?? `local_${identity.id}`)) throw new Error('桌面会话标识与原历史不一致，未续接');
    const session = await api.getSession(hostId);
    if (!session || session.sessionId !== hostId || session.remoteTarget || normal(session.cwd) !== normal(identity.cwd)) throw new Error('桌面会话归属已变化，请重新打开');
    const tail = await api.getTranscriptTail(hostId, 500);
    if (!matches(tail?.messages, identity)) throw new Error('无法核实这条桌面会话对应的原始历史，未续接');
    return session;
  }
  async function open(identity) {
    const sessions = await api.getAll();
    const found = [];
    for (const session of sessions.filter(s => !s.remoteTarget && normal(s.cwd) === normal(identity.cwd))) {
      try { await verify(session.sessionId, identity); found.push(session.sessionId); } catch { /* Not this transcript. */ }
    }
    if (found.length > 1) throw new Error('多条桌面会话包含相同历史，无法安全选择，请在电脑上确认');
    let hostId = found[0];
    if (!hostId) {
      const listed = await api.listResumableCliSessions(500);
      const candidates = (Array.isArray(listed) ? listed : listed?.sessions || []).filter(s => normal(s.cwd) === normal(identity.cwd) && Math.abs(s.lastActivityAt - identity.modifiedAt) < 2);
      const selected = [];
      for (const row of candidates) {
        const first = await api.readCliTranscript(row.handle, 0, 1);
        const tail = await api.readCliTranscript(row.handle, Math.max(0, first.totalMessages - 32), 32);
        if (matches(tail.messages, identity)) selected.push(row);
      }
      if (selected.length !== 1) throw new Error('桌面尚未提供这条历史的唯一恢复入口，请在电脑上打开一次');
      const preview = await api.previewCliResume(selected[0].handle);
      if (preview?.resumable !== true) refuse(preview?.reason);
      const result = await api.resumeCliSession(selected[0].handle);
      if (!result?.ok || typeof result.sessionId !== 'string') refuse(result?.reason);
      hostId = result.sessionId;
      await verify(hostId, identity);
    }
    // Normal Desktop warm honours its ownership, trust and crash-loop guards.
    await api.warmSession(hostId);
    return { hostId };
  }
  globalThis.__remoteccClaudeActivation = {
    version: 2,
    verify(hostId, identity, registeredHostId) { return verify(hostId, identity, registeredHostId).then(() => true); },
    open(identity) {
      if (flights.has(identity.id)) return flights.get(identity.id);
      const work = open(identity).finally(() => flights.delete(identity.id)); flights.set(identity.id, work); return work;
    },
    async send(hostId, identity, text, messageUuid, registeredHostId) {
      await verify(hostId, identity, registeredHostId);
      // Exact Desktop preload signature. Do not mark a synthetic physical-page
      // press or change permission mode; reject undelivered sends explicitly.
      await api.sendMessage(hostId, text, undefined, undefined, undefined, undefined, undefined, messageUuid, undefined, undefined, undefined, undefined, undefined, undefined, { rejectUndelivered: true });
      return true;
    }
  };
})();
