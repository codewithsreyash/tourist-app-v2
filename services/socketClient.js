import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { extractCoordinates } from "./trackingSession";

const TOURIST_SOCKET_EVENTS = {
  touristLocationUpdate: "tourist_location_update",
  touristSosPanic: "tourist_sos_panic",
};

const OFFLINE_QUEUE_KEY = "safeguard.socket-offline-queue";
const SOCKET_STATUS = {
  CONNECTING: "Connecting",
  LIVE: "Live",
  RECONNECTING: "Reconnecting",
  OFFLINE: "Offline",
};

let touristSocket = null;
let activeSocketBaseUrl = "";
let flushPromise = null;
const socketStatusListeners = new Set();
let socketStatusSnapshot = {
  status: SOCKET_STATUS.OFFLINE,
  queueSize: 0,
};

function normalizeBaseUrl(apiBaseUrl) {
  return typeof apiBaseUrl === "string" ? apiBaseUrl.replace(/\/+$/, "") : "";
}

function buildSocketAuth({ touristId, tripId, deviceId }) {
  return {
    role: "tourist",
    userId: touristId,
    touristId,
    tripId,
    deviceId,
  };
}

function notifySocketStatusListeners() {
  const snapshot = { ...socketStatusSnapshot };
  socketStatusListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.log("Socket status listener failed:", error?.message || error);
    }
  });
}

function setSocketStatus(nextState) {
  socketStatusSnapshot = {
    ...socketStatusSnapshot,
    ...nextState,
  };
  notifySocketStatusListeners();
}

async function readOfflineQueue() {
  const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeOfflineQueue(queue) {
  if (!queue.length) {
    await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
    setSocketStatus({ queueSize: 0 });
    return;
  }

  await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  setSocketStatus({ queueSize: queue.length });
}

function prioritizeQueuedItems(queue) {
  return [...queue].sort((left, right) => {
    const priorityLeft = left?.priority ?? 1;
    const priorityRight = right?.priority ?? 1;
    if (priorityLeft !== priorityRight) {
      return priorityLeft - priorityRight;
    }

    const timestampLeft = new Date(left?.payload?.timestamp || left?.enqueuedAt || 0).getTime();
    const timestampRight = new Date(right?.payload?.timestamp || right?.enqueuedAt || 0).getTime();
    return timestampLeft - timestampRight;
  });
}

function createRecoverableError(message) {
  const error = new Error(message);
  error.recoverable = true;
  return error;
}

function createServerError(message) {
  const error = new Error(message);
  error.recoverable = false;
  return error;
}

function isRecoverableSocketError(error) {
  return Boolean(error?.recoverable);
}

async function enqueueOfflineEvent({ eventName, payload }) {
  const queue = prioritizeQueuedItems(await readOfflineQueue());
  queue.push({
    id: `${eventName}-${payload.timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    eventName,
    payload,
    priority: eventName === TOURIST_SOCKET_EVENTS.touristSosPanic ? 0 : 1,
    enqueuedAt: new Date().toISOString(),
  });

  const prioritizedQueue = prioritizeQueuedItems(queue);
  await writeOfflineQueue(prioritizedQueue);
  return {
    queued: true,
    queueSize: prioritizedQueue.length,
  };
}

function createSocket({ apiBaseUrl, touristId, tripId, deviceId, forceNew = false }) {
  return io(normalizeBaseUrl(apiBaseUrl), {
    autoConnect: false,
    forceNew,
    reconnection: !forceNew,
    transports: ["websocket"],
    auth: buildSocketAuth({ touristId, tripId, deviceId }),
  });
}

function getSharedSocket({ apiBaseUrl, touristId, tripId, deviceId }) {
  const normalizedBaseUrl = normalizeBaseUrl(apiBaseUrl);
  if (!touristSocket || activeSocketBaseUrl !== normalizedBaseUrl) {
    if (touristSocket) {
      touristSocket.disconnect();
    }

    touristSocket = createSocket({ apiBaseUrl: normalizedBaseUrl, touristId, tripId, deviceId });
    activeSocketBaseUrl = normalizedBaseUrl;
    bindSocketLifecycle(touristSocket);
  }

  touristSocket.auth = buildSocketAuth({ touristId, tripId, deviceId });
  return touristSocket;
}

function waitForConnection(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      socket.off("connect", handleConnect);
      socket.off("connect_error", handleConnectError);
    };

    const handleConnect = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const handleConnectError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(
        createRecoverableError(
          error instanceof Error ? error.message : "Socket connection failed."
        )
      );
    };

    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(createRecoverableError("Socket connection timed out."));
    }, timeoutMs);

    socket.on("connect", handleConnect);
    socket.on("connect_error", handleConnectError);
    socket.connect();
  });
}

function emitWithAck(socket, eventName, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(eventName, payload, (error, response) => {
      if (error) {
        reject(createRecoverableError("Socket acknowledgement timed out."));
        return;
      }

      if (response?.status === "error") {
        reject(createServerError(response.message || "Socket request failed."));
        return;
      }

      resolve(response?.data || null);
    });
  });
}

async function flushOfflineQueue(socket) {
  if (flushPromise) {
    return flushPromise;
  }

  flushPromise = (async () => {
    if (!socket?.connected) {
      return [];
    }

    const queue = prioritizeQueuedItems(await readOfflineQueue());
    if (!queue.length) {
      setSocketStatus({ queueSize: 0 });
      return [];
    }

    const remainingItems = [];

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      try {
        await emitWithAck(socket, item.eventName, item.payload);
      } catch (error) {
        if (isRecoverableSocketError(error)) {
          remainingItems.push(...queue.slice(index));
          break;
        }

        console.log("Dropping invalid queued socket event:", error?.message || error);
      }
    }

    await writeOfflineQueue(remainingItems);
    return remainingItems;
  })().finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

function bindSocketLifecycle(socket) {
  if (socket.__safeguardLifecycleBound) {
    return;
  }

  socket.__safeguardLifecycleBound = true;

  socket.on("connect", () => {
    setSocketStatus({ status: SOCKET_STATUS.LIVE });
    void flushOfflineQueue(socket);
  });

  socket.on("disconnect", (reason) => {
    setSocketStatus({
      status: reason === "io client disconnect" ? SOCKET_STATUS.OFFLINE : SOCKET_STATUS.RECONNECTING,
    });
  });

  socket.on("connect_error", () => {
    setSocketStatus({ status: SOCKET_STATUS.RECONNECTING });
  });

  socket.io.on("reconnect_attempt", () => {
    setSocketStatus({ status: SOCKET_STATUS.RECONNECTING });
  });

  socket.io.on("reconnect", () => {
    setSocketStatus({ status: SOCKET_STATUS.LIVE });
    void flushOfflineQueue(socket);
  });

  socket.io.on("reconnect_failed", () => {
    setSocketStatus({ status: SOCKET_STATUS.OFFLINE });
  });
}

async function emitTouristEvent({
  apiBaseUrl,
  touristId,
  tripId,
  deviceId,
  eventName,
  payload,
  ephemeral = false,
}) {
  const socket = ephemeral
    ? createSocket({ apiBaseUrl, touristId, tripId, deviceId, forceNew: true })
    : getSharedSocket({ apiBaseUrl, touristId, tripId, deviceId });

  try {
    if (!ephemeral) {
      setSocketStatus({
        status: socket.connected ? SOCKET_STATUS.LIVE : SOCKET_STATUS.CONNECTING,
      });
    }

    await waitForConnection(socket);

    if (socket.connected) {
      await flushOfflineQueue(socket);
    }

    const response = await emitWithAck(socket, eventName, payload);
    return response;
  } catch (error) {
    if (isRecoverableSocketError(error)) {
      const queueResult = await enqueueOfflineEvent({ eventName, payload });
      if (!ephemeral) {
        setSocketStatus({ status: SOCKET_STATUS.RECONNECTING });
      }
      return queueResult;
    }

    throw error;
  } finally {
    if (ephemeral) {
      socket.disconnect();
    }
  }
}

export function connectTouristSocket({ apiBaseUrl, touristId, tripId, deviceId }) {
  const socket = getSharedSocket({ apiBaseUrl, touristId, tripId, deviceId });
  void readOfflineQueue().then((queue) => {
    setSocketStatus({ queueSize: queue.length });
  });
  setSocketStatus({ status: socket.connected ? SOCKET_STATUS.LIVE : SOCKET_STATUS.CONNECTING });
  socket.connect();
  return socket;
}

export function disconnectTouristSocket() {
  if (!touristSocket) {
    setSocketStatus({ status: SOCKET_STATUS.OFFLINE });
    return;
  }

  touristSocket.disconnect();
  touristSocket = null;
  activeSocketBaseUrl = "";
  setSocketStatus({ status: SOCKET_STATUS.OFFLINE });
}

export function subscribeToSocketStatus(listener) {
  socketStatusListeners.add(listener);
  listener({ ...socketStatusSnapshot });

  return () => {
    socketStatusListeners.delete(listener);
  };
}

export async function emitTouristLocationUpdate({
  apiBaseUrl,
  touristId,
  tripId,
  deviceId,
  location,
  ephemeral = false,
}) {
  const { latitude, longitude, speed } = extractCoordinates(location);
  if (!apiBaseUrl || !touristId || !tripId || !deviceId || latitude === null || longitude === null) {
    return null;
  }

  return emitTouristEvent({
    apiBaseUrl,
    touristId,
    tripId,
    deviceId,
    eventName: TOURIST_SOCKET_EVENTS.touristLocationUpdate,
    payload: {
      userId: touristId,
      touristId,
      tripId,
      deviceId,
      lat: latitude,
      lng: longitude,
      speed,
      timestamp: new Date(location?.timestamp || Date.now()).toISOString(),
    },
    ephemeral,
  });
}

export async function emitTouristSosPanic({
  apiBaseUrl,
  touristId,
  tripId,
  deviceId,
  latitude,
  longitude,
  timestamp,
}) {
  if (!apiBaseUrl || !touristId || !tripId || !deviceId) {
    return null;
  }

  return emitTouristEvent({
    apiBaseUrl,
    touristId,
    tripId,
    deviceId,
    eventName: TOURIST_SOCKET_EVENTS.touristSosPanic,
    payload: {
      userId: touristId,
      touristId,
      tripId,
      deviceId,
      lat: latitude,
      lng: longitude,
      timestamp: timestamp || new Date().toISOString(),
    },
  });
}
