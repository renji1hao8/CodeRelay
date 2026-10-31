/* Observe the same local app-server stream as Desktop. No agent is launched. */
(() => {
  if (globalThis.__remoteccCodexLive) return;
  const sessions = new Map();
  globalThis.addEventListener('message', event => {
    const data = event.data;
    if (data?.hostId !== 'local' || data.type !== 'mcp-notification') return;
    const p = data.params, method = data.method;
    if (!p || typeof p.threadId !== 'string') return;
    let state = sessions.get(p.threadId);
    if (!state) { state = { items: new Map() }; sessions.set(p.threadId, state); }
    if (sessions.size > 12) sessions.delete(sessions.keys().next().value);
    if (method === 'turn/started') state.busy = true;
    if (method === 'turn/completed') state.busy = false;
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'agentMessage' && typeof p.item.id === 'string') {
      const prior = state.items.get(p.item.id);
      state.items.set(p.item.id, { id: p.item.id, text: String(p.item.text || '').slice(0, 64000), ts: prior?.ts || new Date().toISOString() });
    } else if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      // A missing start means the stream was attached mid-item. Wait for the
      // authoritative completion instead of presenting a suffix as full text.
      const item = state.items.get(p.itemId);
      if (item) item.text = (item.text + p.delta).slice(0, 64000);
    }
    while (state.items.size > 50) state.items.delete(state.items.keys().next().value);
  });
  globalThis.__remoteccCodexLive = { snapshot(id) { const state = sessions.get(id); return state ? { busy: state.busy, items: [...state.items.values()] } : { items: [] }; } };
})();
