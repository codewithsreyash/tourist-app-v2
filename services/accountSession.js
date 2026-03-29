import AsyncStorage from "@react-native-async-storage/async-storage";

const ACCOUNT_SESSION_KEY = "safeguard.account-session";

export async function saveAccountSession(account) {
  await AsyncStorage.setItem(ACCOUNT_SESSION_KEY, JSON.stringify(account));
}

export async function getAccountSession() {
  const raw = await AsyncStorage.getItem(ACCOUNT_SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearAccountSession() {
  await AsyncStorage.removeItem(ACCOUNT_SESSION_KEY);
}
