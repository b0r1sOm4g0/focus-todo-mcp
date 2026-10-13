// Runs app service calls for a batch of tasks over one browser session

const occurrence = t => (t && t.id ? { id: t.id, deadline: t.deadline } : undefined);

export function createWriter({ openSession }) {
  async function run(ids, method, nextOf) {
    const session = await openSession();
    try {
      const results = [];
      for (const id of ids) {
        try {
          const next = nextOf(await session.call(method, id));
          results.push(next ? { id, ok: true, nextOccurrence: next } : { id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
      const touched = results.filter(r => r.ok).flatMap(r => [r.id, r.nextOccurrence?.id].filter(Boolean));
      if (touched.length === 0) return { results, pendingSync: [], uiRefreshed: false };
      const pendingSync = await session.syncAndWait(touched);
      const uiRefreshed = await session.refreshIfIdle();
      return { results, pendingSync, uiRefreshed };
    } finally {
      session.close();
    }
  }

  return {
    completeTasks: ids => run(ids, "completeTask", r => occurrence(r?.newTask)),
    skipOccurrences: ids => run(ids, "deleteCurrentRepeatTask", r => occurrence(r)),
    deleteTasks: ids => run(ids, "deleteTask", () => undefined),
  };
}
