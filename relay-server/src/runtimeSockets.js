'use strict';

function getOpenSockets(runtime, wsOpen = 1) {
  if (!runtime) return [];

  const sockets = [];

  if (runtime.sockets instanceof Map) {
    for (const ws of runtime.sockets.values()) {
      if (ws?.readyState === wsOpen) sockets.push(ws);
    }
  }

  if (sockets.length > 0) return sockets;

  if (runtime.ws?.readyState === wsOpen) {
    sockets.push(runtime.ws);
  }

  return sockets;
}

function hasOpenSocket(runtime, wsOpen = 1) {
  return getOpenSockets(runtime, wsOpen).length > 0;
}

function getPrimarySocket(runtime, wsOpen = 1) {
  return getOpenSockets(runtime, wsOpen)[0] || null;
}

function getSocketForInstance(runtime, instanceName, wsOpen = 1) {
  if (instanceName && runtime?.sockets instanceof Map) {
    const ws = runtime.sockets.get(instanceName);
    if (ws?.readyState === wsOpen) return ws;
  }
  return getPrimarySocket(runtime, wsOpen);
}

module.exports = {
  getOpenSockets,
  hasOpenSocket,
  getPrimarySocket,
  getSocketForInstance,
};
