import { Platform } from "react-native";
import * as Application from "expo-application";

export async function getDeviceId() {
  try {
    if (Platform.OS === "android") {
      const androidId = Application.getAndroidId();
      if (androidId) {
        return androidId;
      }
    }

    if (Platform.OS === "ios") {
      const iosId = await Application.getIosIdForVendorAsync();
      if (iosId) {
        return iosId;
      }
    }
  } catch (error) {
    console.log("Unable to resolve native device ID:", error?.message || error);
  }

  return `${Application.applicationId || "safeguard"}-${Platform.OS}-fallback`;
}
