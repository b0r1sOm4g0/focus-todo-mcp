// Minimal Chrome DevTools Protocol client over Node's native WebSocket

export async function connectCDP(wsUrl, { timeoutMs = 10_000, requestTimeoutMs = 60_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const ws = new WebSocketImpl(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP connection timed out: ${wsUrl}`)); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`CDP connection failed: ${wsUrl}`)); };
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  ws.onclose = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP connection closed")); }
    pending.clear();
  };

  // Never leaves a caller waiting: closed sockets reject at once, silent ones time out
  function send(method, params = {}) {
    if (ws.readyState !== (WebSocketImpl.OPEN ?? 1)) return Promise.reject(new Error("CDP connection closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${requestTimeoutMs / 1000}s`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, method, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const description = r.exceptionDetails.exception?.description;
      throw new Error(description ? description.split("\n")[0].replace(/^\w*Error: /, "") : r.exceptionDetails.text);
    }
    return r.result.value;
  }

  return { send, evaluate, close: () => ws.close() };
}
