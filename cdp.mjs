// Minimal Chrome DevTools Protocol client over Node's native WebSocket

export async function connectCDP(wsUrl, { timeoutMs = 10_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP connection timed out: ${wsUrl}`)), timeoutMs);
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
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("CDP connection closed"));
    pending.clear();
  };

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  return { send, evaluate, close: () => ws.close() };
}
