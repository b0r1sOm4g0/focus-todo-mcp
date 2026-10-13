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

test("without elicitation the form is unavailable", async () => {
  const s = fakeServer({ caps: {} });
  assert.equal(await createConfirm(s)({ message: "m" }), "unavailable");
  assert.equal(s.calls.length, 0);
});

test("unavailable when the client rejects form elicitation", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, error: new Error("Client does not support form elicitation.") });
  assert.equal(await createConfirm(s)({ message: "m" }), "unavailable");
});

test("other elicitation errors propagate", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, error: new Error("Request timed out") });
  await assert.rejects(createConfirm(s)({ message: "m" }), /timed out/);
});
