import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import { emitTouristLocationUpdate } from "./socketClient";
import { getTrackingSession, saveTrackingSession } from "./trackingSession";

export const BACKGROUND_LOCATION_TASK = "SAFEGUARD_BACKGROUND_LOCATION_TASK";

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      console.log("Background location task error:", error.message);
      return;
    }

    const session = await getTrackingSession();
    if (!session?.touristId || !session?.apiBaseUrl || !session?.tripId || !session?.deviceId) {
      return;
    }

    const locations = Array.isArray(data?.locations) ? data.locations : [];
    for (const location of locations) {
      try {
        await emitTouristLocationUpdate({
          apiBaseUrl: session.apiBaseUrl,
          touristId: session.touristId,
          tripId: session.tripId,
          deviceId: session.deviceId,
          location,
          ephemeral: true,
        });
      } catch (taskError) {
        console.log("Background socket emission skipped:", taskError?.message || taskError);
      }
    }
  });
}

export async function requestTrackingPermissions() {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") {
    return {
      granted: false,
      foregroundGranted: false,
      backgroundGranted: false,
      stage: "foreground",
    };
  }

  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") {
    return {
      granted: false,
      foregroundGranted: true,
      backgroundGranted: false,
      stage: "background",
    };
  }

  return {
    granted: true,
    foregroundGranted: true,
    backgroundGranted: true,
    stage: "background",
  };
}

export async function ensureBackgroundTracking({ touristId, apiBaseUrl, tripId, deviceId }) {
  await saveTrackingSession({ touristId, apiBaseUrl, tripId, deviceId });

  const hasStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (hasStarted) {
    return;
  }

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 10,
    timeInterval: 5000,
    deferredUpdatesDistance: 20,
    deferredUpdatesInterval: 5000,
    activityType: Location.ActivityType.OtherNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "SafeGuard tracking active",
      notificationBody: "Your live location is being shared with the safety desk.",
      notificationColor: "#1d4ed8",
      killServiceOnDestroy: false,
    },
  });
}

export async function stopBackgroundTracking() {
  const hasStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (hasStarted) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}
