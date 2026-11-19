// Minimal CDP client for WorkBuddy (Electron): target picking + Runtime.evaluate + Input events.
// Node 22+ (global WebSocket). No external deps.

export const DEFAULT_PORT = Number(process.env.WB_PORT || 9222);

export async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return await res.json();
}

function openSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws connect failed: ' + url)), { once: true });
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  const send = async (method, params = {}) => {
    await ready;
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { ws, send, ready };
}

// which: 'main' . 'settings' . explicit target id
export async function connect(which = 'main', port = DEFAULT_PORT) {
  const targets = (await listTargets(port)).filter((t) => t.type === 'page');
  if (!targets.length) throw new Error('no page target on port ' + port);
  let target = null;
  if (which && which !== 'main' && which !== 'settings') {
    target = targets.find((t) => t.id === which);
  }
  if (!target) {
    for (const t of targets) {
      const client = openSocket(t.webSocketDebuggerUrl);
      try {
        const r = await client.send('Runtime.evaluate', {
          expression: "!!document.querySelector('.settings-modal') ? 'settings' : 'main'",
          returnByValue: true,
        });
        const kind = r.result?.value;
        if (kind === which) {
          target = t;
          return { ...client, target };
        }
      } catch {
        /* unreachable target */
      }
      client.ws.close();
    }
  }
  if (!target) throw new Error(`no ${which} target`);
  const client = openSocket(target.webSocketDebuggerUrl);
  return { ...client, target };
}

export async function evaluate(which, expression, port = DEFAULT_PORT) {
  const { send, ws } = await connect(which, port);
  try {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
      throw new Error(desc);
    }
    return r.result?.value;
  } finally {
    ws.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
