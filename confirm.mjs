// Ask the user to approve a write: native form when supported, otherwise a two-call preview

const SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Confirm", description: "Apply these changes to Focus To-Do" },
  },
  required: ["confirm"],
};

export function createConfirm(server) {
  return async function confirm({ message, confirmed }) {
    if (server.getClientCapabilities()?.elicitation) {
      try {
        const r = await server.elicitInput({ mode: "form", message, requestedSchema: SCHEMA });
        return r.action === "accept" && r.content?.confirm === true ? "accepted" : "declined";
      } catch (err) {
        if (!/does not support/i.test(err.message)) throw err;
      }
    }
    return confirmed === true ? "accepted" : "preview";
  };
}
