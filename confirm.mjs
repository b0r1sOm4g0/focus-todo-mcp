// Ask the user to approve a write with a native form; "unavailable" when the client has none

const SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Confirm", description: "Apply these changes to Focus To-Do" },
  },
  required: ["confirm"],
};

export function createConfirm(server) {
  return async function confirm({ message }) {
    if (!server.getClientCapabilities()?.elicitation) return "unavailable";
    try {
      const r = await server.elicitInput({ mode: "form", message, requestedSchema: SCHEMA });
      return r.action === "accept" && r.content?.confirm === true ? "accepted" : "declined";
    } catch (err) {
      if (/does not support/i.test(err.message)) return "unavailable";
      throw err;
    }
  };
}
