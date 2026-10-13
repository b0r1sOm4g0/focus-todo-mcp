import { test } from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../cdp.mjs";

// Minimal stand-in for the WebSocket global: opens on the next tick unless told not to
function fakeWebSocket({ opens = true } = {}) {
  return class FakeWS {
    static OPEN = 1;
    static last;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWS.last = this;
      if (opens) setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    reply(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  };
}

test("replies resolve the matching request", async () => {
  const WS = fakeWebSocket();
  const cdp = await connectCDP("ws://x", { WebSocketImpl: WS });
  const p = cdp.send("Runtime.evaluate", { expression: "1" });
  WS.last.reply({ id: WS.last.sent[0].id, result: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
});

test("send rejects immediately once the socket is closed", async () => {
  const WS = fakeWebSocket();
  const cdp = await connectCDP("ws://x", { WebSocketImpl: WS });
  WS.last.close();
  await assert.rejects(cdp.send("Runtime.evaluate"), /closed/);
});

test("a request with no reply times out", async () => {
  const WS = fakeWebSocket();
  const cdp = await connectCDP("ws://x", { WebSocketImpl: WS, requestTimeoutMs: 30 });
  await assert.rejects(cdp.send("Runtime.evaluate"), /Runtime.evaluate timed out/);
});

test("a connection that never opens times out and is closed", async () => {
  const WS = fakeWebSocket({ opens: false });
  await assert.rejects(connectCDP("ws://x", { WebSocketImpl: WS, timeoutMs: 20 }), /timed out/);
  assert.equal(WS.last.readyState, 3);
});

test("page exceptions surface as their message, without the stack", async () => {
  const WS = fakeWebSocket();
  const cdp = await connectCDP("ws://x", { WebSocketImpl: WS });
  const p = cdp.evaluate("throw new Error('task no longer exists')");
  WS.last.reply({ id: WS.last.sent[0].id, result: { exceptionDetails: { text: "Uncaught", exception: { description: "Error: task no longer exists\n    at <anonymous>:1:7" } } } });
  await assert.rejects(p, err => err.message === "task no longer exists");
});
