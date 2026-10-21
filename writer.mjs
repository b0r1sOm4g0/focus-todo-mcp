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
    createTask: fields => serialized(async () => {
      const session = await openSession();
      try {
        const result = await session.evaluate(`(async () => {
          const s = window.__focusTodoMcp && window.__focusTodoMcp.taskService;
          if (!s) throw new Error("focus-todo-mcp: taskService not located");
          const fields = ${JSON.stringify(fields)};
          const task = await s.addTask(fields);
          return task == null ? null : JSON.parse(JSON.stringify(task));
        })()`);
        const id = result?.id || fields.id;
        let pendingSync = id ? [id] : [], uiRefreshed = false, warning;
        try {
          if (id) pendingSync = await session.syncAndWait([id]);
          uiRefreshed = await session.refreshIfIdle();
        } catch (err) {
          warning = `Task created, but sync/refresh failed: ${err.message}`;
        }
        const out = [`Created task: ${fields.name} (${id || "unknown id"})`];
        if (warning) out.push(warning);
        if (pendingSync.length) out.push(`Saved locally but not yet confirmed by the sync server: ${pendingSync.join(", ")}.`);
        if (!uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the task on its next refresh.");
        return out.join("\n");
      } finally {
        session.close();
      }
    }),
    // successorOf: tasks whose series already has a later active occurrence are finished without
    // generating another one (the app's completeTask always generates)
    completeTasks: (ids, { successorOf = {} } = {}) => serialized(() => run(ids,
      id => (successorOf[id] ? "finishOnly" : "completeTask"),
      r => occurrence(r?.newTask),
      id => (successorOf[id] ? { successorId: successorOf[id] } : {}))),
    uncompleteTasks: ids => serialized(() => run(ids, () => "uncompleteTask", () => undefined, () => ({ allowFinished: true }))),
    skipOccurrences: ids => serialized(() => run(ids, () => "deleteCurrentRepeatTask", r => occurrence(r), () => ({ recurring: true }))),
    deleteTasks: (ids, { keepOf = {}, allowFinished = false } = {}) => serialized(() => run(ids, () => "deleteTask", () => undefined, id => ({ ...(allowFinished ? { allowFinished: true } : {}), ...(keepOf[id] ? { keepId: keepOf[id] } : {}) }))),
    updateTask: (id, patch) => serialized(async () => {
      const session = await openSession();
      try {
        const updated = await session.call("updateTaskInfo", id, { allowFinished: true, patch });
        let pendingSync = [id], uiRefreshed = false, warning;
        try {
          pendingSync = await session.syncAndWait([id]);
          uiRefreshed = await session.refreshIfIdle();
        } catch (err) {
          warning = `The changes were applied, but confirming the sync or refreshing the window failed: ${err.message}`;
        }
        const out = [`Updated task: ${updated?.name || id}`];
        if (warning) out.push(warning);
        if (pendingSync.length) out.push(`Saved locally but not yet confirmed by the sync server: ${pendingSync.join(", ")}.`);
        if (!uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the update on its next refresh.");
        return out.join("\n");
      } finally {
        session.close();
      }
    }),
    createSubtask: ({ taskId, name, estimatedPomoNum = 0 }) => serialized(async () => {
      const session = await openSession();
      try {
        const result = await session.evaluate(`(async () => {
          const ts = window.__focusTodoMcp && window.__focusTodoMcp.taskService;
          const ss = window.__focusTodoMcp && window.__focusTodoMcp.subtaskService;
          if (!ts) throw new Error("focus-todo-mcp: taskService not located");
          if (!ss) throw new Error("focus-todo-mcp: subtaskService not located");
          const parent = await ts.fetchTaskById(${JSON.stringify(taskId)});
          if (!parent) throw new Error("Parent task not found: " + ${JSON.stringify(taskId)});
          const subtask = await ss.addSubtask({
            taskId: ${JSON.stringify(taskId)},
            name: ${JSON.stringify(name)},
            estimatedPomoNum: ${Number(estimatedPomoNum) || 0},
          });
          if (!parent.hasSubtask) {
            await ts.updateTaskInfo(${JSON.stringify(taskId)}, { hasSubtask: true });
          }
          return subtask == null ? null : JSON.parse(JSON.stringify(subtask));
        })()`);
        const id = result?.id;
        let pendingSync = [taskId], uiRefreshed = false, warning;
        try {
          pendingSync = await session.syncAndWait([taskId, ...(id ? [id] : [])]);
          uiRefreshed = await session.refreshIfIdle();
        } catch (err) {
          warning = `Subtask created, but sync/refresh failed: ${err.message}`;
        }
        const out = [`Created subtask: "${name}" (${id || "unknown id"})`];
        if (warning) out.push(warning);
        if (pendingSync.length) out.push(`Saved locally but not yet confirmed by the sync server: ${pendingSync.join(", ")}.`);
        if (!uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the subtask on its next refresh.");
        return out.join("\n");
      } finally {
        session.close();
      }
    }),
    updateSubtask: (id, updates) => serialized(async () => {
      const session = await openSession();
      try {
        const result = await session.evaluate(`(async () => {
          const ss = window.__focusTodoMcp && window.__focusTodoMcp.subtaskService;
          if (!ss) throw new Error("focus-todo-mcp: subtaskService not located");
          const existing = await ss.fetchSubtaskById(${JSON.stringify(id)});
          if (!existing) throw new Error("Subtask not found: " + ${JSON.stringify(id)});
          const u = ${JSON.stringify(updates)};
          let res;
          if (u.isDeleted) {
            res = await ss.deleteSubtask(${JSON.stringify(id)});
          } else {
            const patch = {};
            if (u.name !== undefined) patch.name = u.name;
            if (u.isFinished !== undefined) {
              patch.isFinished = u.isFinished;
              patch.finishedDate = u.isFinished ? Date.now() : 0;
            }
            if (u.estimatedPomoNum !== undefined) patch.estimatedPomoNum = u.estimatedPomoNum;
            res = await ss.updateSubtaskInfo(${JSON.stringify(id)}, patch);
          }
          return res == null ? null : JSON.parse(JSON.stringify(res));
        })()`);
        let pendingSync = [id], uiRefreshed = false, warning;
        try {
          pendingSync = await session.syncAndWait([id]);
          uiRefreshed = await session.refreshIfIdle();
        } catch (err) {
          warning = `Subtask updated, but sync/refresh failed: ${err.message}`;
        }
        const verb = updates.isDeleted ? "Deleted" : updates.isFinished !== undefined ? (updates.isFinished ? "Completed" : "Reopened") : "Updated";
        const out = [`${verb} subtask: "${result?.name || id}"`];
        if (warning) out.push(warning);
        if (pendingSync.length) out.push(`Saved locally but not yet confirmed by the sync server: ${pendingSync.join(", ")}.`);
        if (!uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the change on its next refresh.");
        return out.join("\n");
      } finally {
        session.close();
      }
    }),
    createProject: ({ name, color, isTag = false }) => serialized(async () => {
      const session = await openSession();
      try {
        const result = await session.evaluate(`(async () => {
          const ps = window.__focusTodoMcp && window.__focusTodoMcp.projectService;
          if (!ps) throw new Error("focus-todo-mcp: projectService not located");
          const fields = {
            name: ${JSON.stringify(name)},
            type: ${isTag ? 3000 : 1000},
          };
          if (${JSON.stringify(color || "")}) {
            fields.color = ${JSON.stringify((color || "").replace(/^#/, ""))};
          }
          const project = await ps.addProject(fields);
          return project == null ? null : JSON.parse(JSON.stringify(project));
        })()`);
        const id = result?.id;
        let uiRefreshed = false, warning;
        try {
          uiRefreshed = await session.refreshIfIdle();
        } catch (err) {
          warning = `Project created, but window refresh failed: ${err.message}`;
        }
        const kind = isTag ? "tag" : "project";
        const out = [`Created ${kind}: "${name}" (${id || "unknown id"})`];
        if (warning) out.push(warning);
        if (!uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the new item on its next refresh.");
        return out.join("\n");
      } finally {
        session.close();
      }
    }),
  };
}
