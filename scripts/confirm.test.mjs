import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfirm } from "../confirm.mjs";

function fakeServer({ caps, reply, error } = {}) {
  const calls = [];
  return {
    calls,
    getClientCapabilities: () => caps,
    elicitInput: async params => { calls.push(params); if (error) throw error; return reply; },
  };
}

test("accepts when the user confirms the form", async () => {
  const s = fakeServer({ caps: { elicitation: { form: {} } }, reply: { action: "accept", content: { confirm: true } } });
  assert.equal(await createConfirm(s)({ message: "Complete 2 task(s)?" }), "accepted");
  assert.equal(s.calls[0].mode, "form");
  assert.equal(s.calls[0].message, "Complete 2 task(s)?");
  assert.deepEqual(s.calls[0].requestedSchema.required, ["confirm"]);
});

test("unchecked box, decline and cancel all mean declined", async () => {
  for (const reply of [{ action: "accept", content: { confirm: false } }, { action: "decline" }, { action: "cancel" }]) {
    const s = fakeServer({ caps: { elicitation: {} }, reply });
    assert.equal(await createConfirm(s)({ message: "m" }), "declined");
  }
});

test("confirmed flag cannot bypass the form when elicitation is available", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, reply: { action: "decline" } });
  assert.equal(await createConfirm(s)({ message: "m", confirmed: true }), "declined");
});

test("without elicitation: preview first, accepted with confirmed", async () => {
  const s = fakeServer({ caps: {} });
  assert.equal(await createConfirm(s)({ message: "m" }), "preview");
  assert.equal(await createConfirm(s)({ message: "m", confirmed: true }), "accepted");
  assert.equal(s.calls.length, 0);
});

test("falls back to preview when the client rejects form elicitation", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, error: new Error("Client does not support form elicitation.") });
  assert.equal(await createConfirm(s)({ message: "m" }), "preview");
});

test("other elicitation errors propagate", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, error: new Error("Request timed out") });
  await assert.rejects(createConfirm(s)({ message: "m" }), /timed out/);
});
