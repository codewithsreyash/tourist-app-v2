import AsyncStorage from "@react-native-async-storage/async-storage";

const TRACKING_SESSION_KEY = "safeguard.tracking-session";

export async function saveTrackingSession(session) {
  await AsyncStorage.setItem(TRACKING_SESSION_KEY, JSON.stringify(session));
}

export async function getTrackingSession() {
  const raw = await AsyncStorage.getItem(TRACKING_SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearTrackingSession() {
  await AsyncStorage.removeItem(TRACKING_SESSION_KEY);
}

export function extractCoordinates(location) {
  const latitude =
    typeof location?.coords?.latitude === "number"
      ? location.coords.latitude
      : typeof location?.latitude === "number"
        ? location.latitude
        : null;
  const longitude =
    typeof location?.coords?.longitude === "number"
      ? location.coords.longitude
      : typeof location?.longitude === "number"
        ? location.longitude
        : null;
  const speed =
    typeof location?.coords?.speed === "number"
      ? location.coords.speed
      : typeof location?.speed === "number"
        ? location.speed
        : 0;

  return { latitude, longitude, speed };
}
