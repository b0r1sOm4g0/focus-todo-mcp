// Talks to the Focus To-Do page: finds the app's service singletons and calls them
import { connectCDP } from "./cdp.mjs";
import { ensureBrowser, findExtensionTarget } from "./browser.mjs";
import { getConfig } from "./config.mjs";
import { liveTaskProblem, appliedProblem } from "./guards.mjs";

const GROUP = "focus-todo-mcp";
const SERVICES_LOST = "focus-todo-mcp: services not located";
const SHAPES = {
  taskService: ["completeTask", "deleteCurrentRepeatTask", "deleteTask", "fetchTaskById"],
  synchronizer: ["syncNow", "sync", "updateProgressBar"],
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const APP_STATE = `(() => {
  const root = document.getElementById("root");
  if (document.readyState !== "complete" || !root || !root._reactRootContainer) return "loading";
  return localStorage.getItem("cookie.ACCT") ? "ready" : "logged-out";
})()`;

// One function per mounted component type; their closures reach the app's modules
const COLLECT_FUNCTIONS = `(() => {
  const root = document.getElementById("root")._reactRootContainer._internalRoot.current;
  const fns = [], seen = new Set(), stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f) continue;
    stack.push(f.sibling, f.child);
    const sn = f.stateNode;
    if (!sn || sn instanceof Node || typeof sn !== "object" || seen.has(f.type)) continue;
    seen.add(f.type);
    const own = Object.values(sn).find(v => typeof v === "function");
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(sn))
      .filter(k => k !== "constructor")
      .map(k => sn[k])
      .find(v => typeof v === "function");
    if (own || proto) fns.push(own || proto);
  }
  return fns;
})()`;

// Called with \`this\` = a closure variable; stores matching singletons on window
const PROBE = `function (shapes) {
  const s = this && this.default && this.default.shared;
  if (!s || typeof s !== "object") return null;
  const store = (window.__focusTodoMcp = window.__focusTodoMcp || {});
  for (const [name, methods] of Object.entries(shapes)) {
    if (!store[name] && methods.every(m => typeof s[m] === "function")) { store[name] = s; return name; }
  }
  return null;
}`;

const TIMER_STATE = `(() => {
  const root = document.getElementById("root")._reactRootContainer._internalRoot.current;
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f) continue;
    stack.push(f.sibling, f.child);
    const store = f.memoizedProps && f.memoizedProps.store;
    if (store && typeof store.getState === "function") return store.getState().timerInfo?.state ?? null;
  }
  return null;
})()`;

async function waitForApp(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(APP_STATE).catch(() => "loading");
    if (state === "ready") return;
    if (state === "logged-out") throw new Error("Not logged in to Focus To-Do in the dedicated Chrome. Log in there and try again.");
    await sleep(250);
  }
  throw new Error("Focus To-Do page did not finish loading in 20s.");
}

async function located(cdp) {
  return cdp.evaluate(`(() => { const s = window.__focusTodoMcp || {}; return ${JSON.stringify(Object.keys(SHAPES))}.filter(k => !s[k]); })()`);
}

async function locateServices(cdp) {
  if ((await located(cdp)).length === 0) return;
  try {
    const list = await cdp.send("Runtime.evaluate", { expression: COLLECT_FUNCTIONS, objectGroup: GROUP });
    const items = (await cdp.send("Runtime.getProperties", { objectId: list.result.objectId, ownProperties: true })).result
      .filter(p => /^\d+$/.test(p.name) && p.value?.objectId);
    for (const item of items) {
      let fnId = item.value.objectId, scopes;
      for (let hop = 0; hop < 2 && !scopes; hop++) {
        const internal = (await cdp.send("Runtime.getProperties", { objectId: fnId })).internalProperties ?? [];
        scopes = internal.find(p => p.name === "[[Scopes]]");
        const target = internal.find(p => p.name === "[[TargetFunction]]");
        if (!scopes && target) fnId = target.value.objectId;
      }
      if (!scopes) continue;
      for (const scope of (await cdp.send("Runtime.getProperties", { objectId: scopes.value.objectId })).result) {
        if (!scope.value?.objectId) continue;
        const vars = (await cdp.send("Runtime.getProperties", { objectId: scope.value.objectId })).result;
        if (vars.length > 200) continue; // global/script scopes
        for (const v of vars) {
          if (v.value?.type !== "object" || !v.value.objectId) continue;
          await cdp.send("Runtime.callFunctionOn", { objectId: v.value.objectId, functionDeclaration: PROBE, arguments: [{ value: SHAPES }], returnByValue: true });
        }
      }
      if ((await located(cdp)).length === 0) return;
    }
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
  }
  const missing = await located(cdp);
  if (missing.length) {
    const version = await cdp.evaluate("chrome.runtime.getManifest().version").catch(() => "unknown");
    throw new Error(`Focus To-Do services not found (extension ${version}); missing: ${missing.map(m => `${m} [${SHAPES[m].join(", ")}]`).join("; ")}. The extension may have changed.`);
  }
}

// Re-checks the live record first (the reader's snapshot may be stale and the app's methods check
// nothing), calls the app, then reads the record back so success is reported only if it applied
function callService(cdp, method, id, guard = {}) {
  return cdp.evaluate(`(async () => {
    const liveTaskProblem = ${liveTaskProblem.toString()};
    const appliedProblem = ${appliedProblem.toString()};
    const s = window.__focusTodoMcp && window.__focusTodoMcp.taskService;
    if (!s) throw new Error(${JSON.stringify(SERVICES_LOST)});
    const method = ${JSON.stringify(method)}, id = ${JSON.stringify(id)}, guard = ${JSON.stringify(guard)};
    const task = await s.fetchTaskById(id);
    const keep = guard.keepId ? await s.fetchTaskById(guard.keepId) : undefined;
    const before = liveTaskProblem(task, guard, keep);
    if (before) throw new Error(before);
    const r = await s[method](id);
    const after = appliedProblem(method, await s.fetchTaskById(id));
    if (after) throw new Error(after);
    return r == null ? null : JSON.parse(JSON.stringify(r));
  })()`);
}

// IDs whose record still has sync !== 1 (missing records count as synced)
function unsynced(cdp, ids) {
  return cdp.evaluate(`(async () => {
    const ids = ${JSON.stringify(ids)};
    const name = (await indexedDB.databases()).map(d => d.name).find(n => /^PomodoroDB/.test(n));
    const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    try {
      const st = db.transaction("Task").objectStore("Task");
      const rows = await Promise.all(ids.map(id => new Promise(res => { const q = st.get(id); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); })));
      return ids.filter((id, i) => rows[i] && rows[i].sync !== 1);
    } finally { db.close(); }
  })()`);
}

async function syncAndWait(cdp, ids, timeoutMs = 30_000) {
  await locateServices(cdp);
  await cdp.evaluate("void window.__focusTodoMcp.synchronizer.syncNow(); true");
  const deadline = Date.now() + timeoutMs;
  let pending = await unsynced(cdp, ids);
  while (pending.length && Date.now() < deadline) {
    await sleep(1000);
    pending = await unsynced(cdp, ids);
  }
  return pending;
}

// Reload only with the timer idle, and wait for the app so the next session never races the reload
async function refreshIfIdle(cdp) {
  const state = await cdp.evaluate(TIMER_STATE).catch(() => null);
  if (state !== "initial") return false;
  await cdp.send("Page.reload");
  await sleep(500);
  await waitForApp(cdp);
  return true;
}

export async function openSession({ config = getConfig() } = {}) {
  const base = await ensureBrowser({ config });
  const target = await findExtensionTarget(base);
  const cdp = await connectCDP(target.webSocketDebuggerUrl);
  try {
    await waitForApp(cdp);
    await locateServices(cdp);
  } catch (err) {
    cdp.close();
    throw err;
  }
  return {
    async call(method, id, guard) {
      try {
        return await callService(cdp, method, id, guard);
      } catch (err) {
        if (!String(err.message).includes(SERVICES_LOST)) throw err;
        await waitForApp(cdp);
        await locateServices(cdp);
        return callService(cdp, method, id, guard);
      }
    },
    syncAndWait: (ids, timeoutMs) => syncAndWait(cdp, ids, timeoutMs),
    refreshIfIdle: () => refreshIfIdle(cdp),
    evaluate: expression => cdp.evaluate(expression),
    close: () => cdp.close(),
  };
}
