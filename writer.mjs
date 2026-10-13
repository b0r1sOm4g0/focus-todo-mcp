// Runs app service calls for a batch of tasks over one browser session

const occurrence = t => (t && t.id ? { id: t.id, deadline: t.deadline } : undefined);

export function createWriter({ openSession }) {
  // One write at a time: parallel tool calls would act on the same snapshot and race page reloads
  let queue = Promise.resolve();
  const serialized = fn => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  async function run(ids, methodOf, nextOf, guardOf) {
    const session = await openSession();
    try {
      const results = [];
      for (const id of ids) {
        try {
          const next = nextOf(await session.call(methodOf(id), id, guardOf(id)));
          results.push(next ? { id, ok: true, nextOccurrence: next } : { id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
      const touched = results.filter(r => r.ok).flatMap(r => [r.id, r.nextOccurrence?.id].filter(Boolean));
      if (touched.length === 0) return { results, pendingSync: [], uiRefreshed: false };
      // The writes are committed at this point; later failures must not hide their results
      let pendingSync = touched, uiRefreshed = false, warning;
      try {
        pendingSync = await session.syncAndWait(touched);
        uiRefreshed = await session.refreshIfIdle();
      } catch (err) {
        warning = `The changes were applied, but confirming the sync or refreshing the window failed: ${err.message}`;
      }
      return warning ? { results, pendingSync, uiRefreshed, warning } : { results, pendingSync, uiRefreshed };
    } finally {
      session.close();
    }
  }

  return {
    // successorOf: tasks whose series already has a later active occurrence are finished without
    // generating another one (the app's completeTask always generates)
    completeTasks: (ids, { successorOf = {} } = {}) => serialized(() => run(ids,
      id => (successorOf[id] ? "finishOnly" : "completeTask"),
      r => occurrence(r?.newTask),
      id => (successorOf[id] ? { successorId: successorOf[id] } : {}))),
    skipOccurrences: ids => serialized(() => run(ids, () => "deleteCurrentRepeatTask", r => occurrence(r), () => ({ recurring: true }))),
    deleteTasks: (ids, { keepOf = {} } = {}) => serialized(() => run(ids, () => "deleteTask", () => undefined, id => (keepOf[id] ? { keepId: keepOf[id] } : {}))),
  };
}
