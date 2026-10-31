/* Local xterm renderer. Authentication and network remain in React Native. */
(() => {
  const post = frame => window.ReactNativeWebView?.postMessage(JSON.stringify(frame));
  const terminal = new Terminal({ fontFamily: 'monospace', fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 1500,
    theme: window.REMOTE_CC_TERMINAL_THEME, allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit);
  terminal.open(document.getElementById('terminal'));
  let ctrl = false, seq = -1, id = null, ready = false, pending = [];
  // Backend headless xterm answers device queries once. Restoring/repainting a
  // screen on a phone must never turn terminal responses into duplicate input.
  terminal.parser.registerCsiHandler({ final: 'n' }, () => true);
  terminal.parser.registerCsiHandler({ final: 'c' }, () => true);
  terminal.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true);
  for (const code of [4, 10, 11, 12]) terminal.parser.registerOscHandler(code, value => value.includes('?'));
  terminal.onData(data => {
    if (ctrl && /^[a-zA-Z@\[\]\\^_]$/.test(data)) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); ctrl = false; post({ t: 'controlUsed' }); }
    post({ t: 'input', data });
  });
  terminal.onResize(({ cols, rows }) => { if (ready) post({ t: 'resize', cols, rows }); });
  const size = () => { fit.fit(); return { cols: Math.max(20, terminal.cols), rows: Math.max(5, terminal.rows) }; };
  const data = frame => { if (frame.id !== id || frame.seq <= seq) return; seq = frame.seq; terminal.write(frame.data); };
  const received = new WeakSet();
  const receive = event => {
    if (received.has(event)) return; received.add(event);
    let frame; try { frame = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.t === 'terminal_state') {
      ready = false; id = frame.id; seq = frame.seq;
      terminal.reset(); terminal.resize(frame.cols, frame.rows);
      terminal.write(frame.screen, () => {
        for (const item of pending) data(item); pending = []; ready = true; size();
      });
    } else if (frame.t === 'terminal_data') { if (ready) data(frame); else { pending.push(frame); if (pending.length > 200) pending.shift(); } }
    else if (frame.t === 'focus') terminal.focus();
    else if (frame.t === 'paste' && typeof frame.text === 'string') { terminal.focus(); terminal.paste(frame.text); }
    else if (frame.t === 'control') { ctrl = frame.value === true; terminal.focus(); }
    else if (frame.t === 'copy') post({ t: 'selection', text: terminal.getSelection() });
  };
  document.addEventListener('message', receive); window.addEventListener('message', receive);
  new ResizeObserver(() => size()).observe(document.getElementById('terminal'));
  requestAnimationFrame(() => { post({ t: 'ready', ...size() }); });
})();
