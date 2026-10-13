// Ask the user to approve a write with a native form; "unavailable" when the client has none

const SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Confirm", description: "Apply these changes to Focus To-Do" },
  },
  required: ["confirm"],
};

// Reviewing a long list takes a while; the SDK default is 60s
const FORM_TIMEOUT_MS = 10 * 60_000;

export function createConfirm(server) {
  return async function confirm({ message }) {
    if (!server.getClientCapabilities()?.elicitation) return "unavailable";
    try {
      const r = await server.elicitInput({ mode: "form", message, requestedSchema: SCHEMA }, { timeout: FORM_TIMEOUT_MS });
      return r.action === "accept" && r.content?.confirm === true ? "accepted" : "declined";
    } catch (err) {
      if (/does not support/i.test(err.message)) return "unavailable";
      if (err.code === -32001) return "declined"; // the user did not answer in time
      throw err;
    }
  };
}
