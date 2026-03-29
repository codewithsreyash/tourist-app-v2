import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import axios, { isAxiosError } from "axios";
import * as Location from "expo-location";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { clearAccountSession, getAccountSession, saveAccountSession } from "./services/accountSession";
import { getDeviceId } from "./services/deviceIdentity";
import {
  connectTouristSocket,
  disconnectTouristSocket,
  emitTouristLocationUpdate,
  emitTouristSosPanic,
  subscribeToSocketStatus,
} from "./services/socketClient";
import {
  ensureBackgroundTracking,
  requestTrackingPermissions,
  stopBackgroundTracking,
} from "./services/locationTask";
import { clearTrackingSession } from "./services/trackingSession";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL;
if (!API_BASE_URL) {
  throw new Error("Missing EXPO_PUBLIC_API_URL environment variable.");
}

const DEFAULT_TRIP_ID = "TRIP-INDIA-2026";

function normalizeAccount(payload, fallback = {}) {
  const blockchainId =
    typeof payload?.blockchainId === "string" && payload.blockchainId.trim()
      ? payload.blockchainId
      : typeof payload?.touristId === "string" && payload.touristId.trim()
        ? payload.touristId
        : null;

  if (!blockchainId) {
    return null;
  }

  return {
    blockchainId,
    touristId: blockchainId,
    name:
      typeof payload?.name === "string" && payload.name.trim()
        ? payload.name
        : typeof fallback?.name === "string"
          ? fallback.name
          : "",
    tripId:
      typeof payload?.tripId === "string" && payload.tripId.trim()
        ? payload.tripId
        : typeof fallback?.tripId === "string"
          ? fallback.tripId
          : DEFAULT_TRIP_ID,
    qrCodeUrl:
      typeof payload?.qrCodeUrl === "string" && payload.qrCodeUrl.trim()
        ? payload.qrCodeUrl
        : null,
    deviceId:
      typeof payload?.deviceId === "string" && payload.deviceId.trim()
        ? payload.deviceId
        : typeof fallback?.deviceId === "string"
          ? fallback.deviceId
          : "",
    safetyScore:
      typeof payload?.safetyScore === "number" && Number.isFinite(payload.safetyScore)
        ? payload.safetyScore
        : 100,
  };
}

function formatDeviceId(deviceId) {
  if (!deviceId) {
    return "Resolving secure device fingerprint...";
  }

  if (deviceId.length <= 16) {
    return deviceId;
  }

  return `${deviceId.slice(0, 8)}...${deviceId.slice(-6)}`;
}

export default function App() {
  const [currentScreen, setCurrentScreen] = useState("Registration");
  const [name, setName] = useState("");
  const [tripId, setTripId] = useState(DEFAULT_TRIP_ID);
  const [deviceId, setDeviceId] = useState("");
  const [account, setAccount] = useState(null);
  const [existingAccount, setExistingAccount] = useState(null);
  const [registrationError, setRegistrationError] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isRecoveringAccount, setIsRecoveringAccount] = useState(false);
  const [isSendingPanic, setIsSendingPanic] = useState(false);
  const [safetyScore, setSafetyScore] = useState(100);
  const [locationStatus, setLocationStatus] = useState("Location idle");
  const [lastKnownCoords, setLastKnownCoords] = useState(null);
  const [socketConnection, setSocketConnection] = useState({
    status: "Offline",
    queueSize: 0,
  });

  const locationSubscription = useRef(null);

  useEffect(() => {
    return subscribeToSocketStatus((snapshot) => {
      setSocketConnection(snapshot);
    });
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function bootstrapSession() {
      try {
        const [resolvedDeviceId, storedAccount] = await Promise.all([getDeviceId(), getAccountSession()]);
        if (!isMounted) {
          return;
        }

        setDeviceId(resolvedDeviceId || "");

        if (storedAccount?.blockchainId) {
          const restoredAccount = normalizeAccount(storedAccount, { deviceId: resolvedDeviceId });
          if (restoredAccount) {
            setAccount(restoredAccount);
            setSafetyScore(restoredAccount.safetyScore || 100);
            setName(restoredAccount.name || "");
            setTripId(restoredAccount.tripId || DEFAULT_TRIP_ID);
            setCurrentScreen("Dashboard");
          }
        }
      } catch (error) {
        console.log("Failed to restore device session:", error?.message || error);
      } finally {
        if (isMounted) {
          setIsBootstrapping(false);
        }
      }
    }

    void bootstrapSession();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const touristId = account?.blockchainId;
    const activeTripId = account?.tripId || DEFAULT_TRIP_ID;

    if (currentScreen !== "Dashboard" || !touristId || !deviceId) {
      return undefined;
    }

    async function pushLocationUpdate(location) {
      try {
        const latestData = await emitTouristLocationUpdate({
          apiBaseUrl: API_BASE_URL,
          touristId,
          tripId: activeTripId,
          deviceId,
          location,
        });

        if (!isMounted) {
          return;
        }

        const nextCoords = {
          latitude: location?.coords?.latitude,
          longitude: location?.coords?.longitude,
        };
        setLastKnownCoords(nextCoords);

        if (latestData?.queued) {
          setLocationStatus(`Offline queue active (${latestData.queueSize || 1} pending)`);
          return;
        }

        const nextSafetyScore =
          typeof latestData?.evaluation?.safetyScore === "number"
            ? latestData.evaluation.safetyScore
            : typeof latestData?.tourist?.safetyScore === "number"
              ? latestData.tourist.safetyScore
              : null;
        const nextTripId =
          typeof latestData?.tourist?.tripId === "string" && latestData.tourist.tripId.trim()
            ? latestData.tourist.tripId
            : typeof latestData?.evaluation?.tripId === "string" && latestData.evaluation.tripId.trim()
              ? latestData.evaluation.tripId
              : activeTripId;

        if (typeof nextSafetyScore === "number") {
          setSafetyScore(nextSafetyScore);
          setAccount((current) => {
            if (!current) {
              return current;
            }

            const nextAccount = {
              ...current,
              safetyScore: nextSafetyScore,
              tripId: nextTripId,
            };
            void saveAccountSession(nextAccount);
            return nextAccount;
          });
        }

        setLocationStatus("Realtime tracking active");
      } catch (error) {
        console.log("Location socket emission skipped:", error?.message || error);
        if (isMounted) {
          setLocationStatus("Realtime channel unavailable, retrying");
        }
      }
    }

    async function startTracking() {
      setLocationStatus("Connecting to SafeGuard realtime channel...");

      try {
        connectTouristSocket({
          apiBaseUrl: API_BASE_URL,
          touristId,
          tripId: activeTripId,
          deviceId,
        });

        const permissionResult = await requestTrackingPermissions();
        if (!isMounted) {
          return;
        }

        if (!permissionResult.foregroundGranted) {
          setLocationStatus("Location access denied");
          Alert.alert(
            "Location Required",
            "SafeGuard needs location access to monitor your route and deliver SOS support.",
            [
              { text: "Not now", style: "cancel" },
              { text: "Open Settings", onPress: () => void Linking.openSettings() },
            ]
          );
          return;
        }

        if (permissionResult.backgroundGranted) {
          await ensureBackgroundTracking({
            touristId,
            apiBaseUrl: API_BASE_URL,
            tripId: activeTripId,
            deviceId,
          });
          if (isMounted) {
            setLocationStatus("Background socket tracking enabled");
          }
        } else {
          setLocationStatus("Foreground only, enable Always Allow in Settings");
          Alert.alert(
            "Enable Always Allow",
            "Choose Always Allow so SafeGuard can continue sending location updates when the app is minimized.",
            [
              { text: "Later", style: "cancel" },
              { text: "Open Settings", onPress: () => void Linking.openSettings() },
            ]
          );
        }

        const currentLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (isMounted) {
          await pushLocationUpdate(currentLocation);
        }

        locationSubscription.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 5000,
            distanceInterval: 10,
          },
          async (location) => {
            if (!isMounted) {
              return;
            }

            await pushLocationUpdate(location);
          }
        );
      } catch (error) {
        console.log("Tracking setup failed:", error?.message || error);
        if (isMounted) {
          setLocationStatus("Tracking unavailable");
        }
      }
    }

    void startTracking();

    return () => {
      isMounted = false;
      if (locationSubscription.current) {
        locationSubscription.current.remove();
        locationSubscription.current = null;
      }
      disconnectTouristSocket();
    };
  }, [account?.blockchainId, account?.tripId, currentScreen, deviceId]);

  const registerTourist = async () => {
    if (!name.trim() || !tripId.trim()) {
      Alert.alert("Error", "Please enter name and trip ID.");
      return;
    }

    if (!deviceId) {
      Alert.alert("Device Not Ready", "Please wait while SafeGuard resolves the device identity.");
      return;
    }

    setIsRegistering(true);
    setRegistrationError("");
    setExistingAccount(null);

    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/tourist/register`,
        {
          name: name.trim(),
          tripId: tripId.trim(),
          deviceId,
        },
        { timeout: 5000 }
      );

      const nextAccount = normalizeAccount(response.data?.data, {
        name: name.trim(),
        tripId: tripId.trim(),
        deviceId,
      });

      if (!nextAccount) {
        throw new Error("Registration completed but the tourist ID was missing from the response.");
      }

      setAccount(nextAccount);
      setSafetyScore(nextAccount.safetyScore || 100);
      setCurrentScreen("Dashboard");
      await saveAccountSession(nextAccount);
      Alert.alert("Registration Complete", "Your device has been linked to a single SafeGuard traveller profile.");
    } catch (error) {
      console.log("Registration failed:", error?.message || error);

      if (isAxiosError(error)) {
        const responseMessage =
          typeof error.response?.data?.message === "string"
            ? error.response.data.message
            : "Could not reach the SafeGuard security server.";

        if (error.response?.status === 409) {
          const recoveredAccount = normalizeAccount(error.response?.data?.data, {
            name: name.trim(),
            tripId: tripId.trim(),
            deviceId,
          });

          setRegistrationError(responseMessage);
          if (recoveredAccount) {
            setExistingAccount(recoveredAccount);
            setTripId(recoveredAccount.tripId || tripId);
            setName(recoveredAccount.name || name);
          }
          return;
        }

        setRegistrationError(responseMessage);
        Alert.alert("Registration Error", responseMessage);
        return;
      }

      const fallbackMessage = "Could not reach the SafeGuard security server.";
      setRegistrationError(fallbackMessage);
      Alert.alert("Registration Error", fallbackMessage);
    } finally {
      setIsRegistering(false);
    }
  };

  const useExistingAccount = async () => {
    if (!existingAccount) {
      return;
    }

    setIsRecoveringAccount(true);
    try {
      const nextAccount = { ...existingAccount, deviceId: existingAccount.deviceId || deviceId };
      setAccount(nextAccount);
      setSafetyScore(nextAccount.safetyScore || 100);
      setCurrentScreen("Dashboard");
      setRegistrationError("");
      await saveAccountSession(nextAccount);
    } finally {
      setIsRecoveringAccount(false);
    }
  };

  const handleSignOut = async () => {
    if (locationSubscription.current) {
      locationSubscription.current.remove();
      locationSubscription.current = null;
    }

    disconnectTouristSocket();
    await stopBackgroundTracking();
    await clearTrackingSession();
    await clearAccountSession();

    setAccount(null);
    setExistingAccount(null);
    setRegistrationError("");
    setSafetyScore(100);
    setLastKnownCoords(null);
    setLocationStatus("Location idle");
    setCurrentScreen("Registration");
  };

  const sendPanicAlert = async () => {
    if (!account?.blockchainId || !deviceId) {
      return;
    }

    setIsSendingPanic(true);
    try {
      let coords = lastKnownCoords;
      if (typeof coords?.latitude !== "number" || typeof coords?.longitude !== "number") {
        const liveLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        coords = {
          latitude: liveLocation.coords.latitude,
          longitude: liveLocation.coords.longitude,
        };
        setLastKnownCoords(coords);
      }

      if (typeof coords?.latitude !== "number" || typeof coords?.longitude !== "number") {
        throw new Error("Location fix unavailable.");
      }

        const panicTimestamp = new Date().toISOString();
        const panicResult = await emitTouristSosPanic({
          apiBaseUrl: API_BASE_URL,
          touristId: account.blockchainId,
          tripId: account.tripId || DEFAULT_TRIP_ID,
          deviceId,
          latitude: coords.latitude,
          longitude: coords.longitude,
          timestamp: panicTimestamp,
        });

      setSafetyScore(0);
      setLocationStatus(
        panicResult?.queued
          ? `SOS queued for delivery (${panicResult.queueSize || 1} pending)`
          : "SOS dispatched through realtime channel"
      );
      setAccount((current) => {
        if (!current) {
          return current;
        }

        const nextAccount = { ...current, safetyScore: 0 };
        void saveAccountSession(nextAccount);
        return nextAccount;
      });
      Alert.alert(
        panicResult?.queued ? "SOS Queued" : "SOS Sent",
        panicResult?.queued
          ? "Your SOS was stored safely on this device and will auto-send as soon as connectivity returns."
          : "Your emergency alert and live coordinates were sent to the SafeGuard control room."
      );
    } catch (error) {
      console.log("SOS failed:", error?.message || error);
      Alert.alert("SOS Failed", "SafeGuard could not send the SOS alert. Please keep the app open and try again.");
    } finally {
      setIsSendingPanic(false);
    }
  };

  if (isBootstrapping) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingShell}>
          <ActivityIndicator size="large" color="#63b3ed" />
          <Text style={styles.loadingTitle}>Preparing SafeGuard</Text>
          <Text style={styles.loadingSubtitle}>Restoring your traveller identity and device security context.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (currentScreen === "Registration") {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>SafeGuard Traveller</Text>
          <Text style={styles.subtitle}>
            Each phone can be linked to one traveller account. Register once, then recover the same profile on this device if needed.
          </Text>

          <View style={styles.deviceCard}>
            <Text style={styles.deviceLabel}>Secure Device ID</Text>
            <Text style={styles.deviceValue}>{formatDeviceId(deviceId)}</Text>
          </View>

          {registrationError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.bannerTitle}>Registration blocked</Text>
              <Text style={styles.bannerText}>{registrationError}</Text>
            </View>
          ) : null}

          <TextInput
            style={styles.input}
            placeholder="Full Name"
            value={name}
            onChangeText={setName}
            placeholderTextColor="#7b8794"
          />

          <TextInput
            style={styles.input}
            placeholder="Trip ID (for example TRIP-INDIA-2026)"
            value={tripId}
            onChangeText={setTripId}
            placeholderTextColor="#7b8794"
            autoCapitalize="characters"
          />

          <TouchableOpacity
            style={[styles.primaryButton, isRegistering && styles.disabledButton]}
            onPress={registerTourist}
            disabled={isRegistering}
          >
            {isRegistering ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.buttonText}>Register Traveller Profile</Text>
            )}
          </TouchableOpacity>

          {existingAccount ? (
            <View style={styles.idCard}>
              <Text style={styles.idLabel}>Existing Device Account</Text>
              <Text style={styles.idHeading}>{existingAccount.name || "Registered traveller"}</Text>
              <Text style={styles.idValue}>{existingAccount.blockchainId}</Text>
              <Text style={styles.idMeta}>Assigned Trip: {existingAccount.tripId || "DEFAULT"}</Text>

              <TouchableOpacity
                style={[styles.secondaryButton, isRecoveringAccount && styles.disabledButton]}
                onPress={useExistingAccount}
                disabled={isRecoveringAccount}
              >
                {isRecoveringAccount ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.buttonText}>Open Existing Dashboard</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <ConnectionBanner status={socketConnection.status} queueSize={socketConnection.queueSize} />
          <View style={styles.header}>
            <Text style={styles.title}>Live Monitoring</Text>
            <Text style={styles.idSubtext}>Traveller ID: {account?.blockchainId}</Text>
          <Text style={styles.locationStatus}>{locationStatus}</Text>
        </View>

        <View style={styles.accountCard}>
          <Text style={styles.accountTitle}>{account?.name || "Traveller profile"}</Text>
          <Text style={styles.accountMeta}>Trip: {account?.tripId || DEFAULT_TRIP_ID}</Text>
          <Text style={styles.accountMeta}>Device: {formatDeviceId(deviceId)}</Text>
        </View>

        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>Current Safety Level</Text>
          <Text style={[styles.scoreValue, { color: safetyScore > 80 ? "#48bb78" : "#f56565" }]}>
            {safetyScore}%
          </Text>
          <Text style={styles.scoreSubtitle}>Status: {safetyScore > 80 ? "Safe" : "Alert"}</Text>
        </View>

        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>Background Location</Text>
          <Text style={styles.infoText}>
            SafeGuard requests foreground plus Always Allow background location so tracking continues when the app is minimized.
          </Text>
          <TouchableOpacity style={styles.outlineButton} onPress={() => void Linking.openSettings()}>
            <Text style={styles.outlineButtonText}>Review App Permissions</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.panicButton, isSendingPanic && styles.disabledButton]}
          onPress={sendPanicAlert}
          disabled={isSendingPanic}
        >
          {isSendingPanic ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.panicText}>SOS PANIC</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out From This Device</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
  },
  loadingShell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loadingTitle: {
    marginTop: 20,
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "700",
  },
  loadingSubtitle: {
    marginTop: 8,
    color: "#94a3b8",
    fontSize: 13,
    textAlign: "center",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#f8fafc",
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    color: "#94a3b8",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  header: {
    marginBottom: 24,
  },
  deviceCard: {
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1d4ed8",
    borderRadius: 16,
    padding: 18,
    marginBottom: 18,
  },
  deviceLabel: {
    fontSize: 11,
    color: "#93c5fd",
    textTransform: "uppercase",
    letterSpacing: 1.4,
    marginBottom: 8,
    fontWeight: "700",
  },
  deviceValue: {
    color: "#eff6ff",
    fontSize: 15,
    fontWeight: "600",
  },
  errorBanner: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#b91c1c",
    backgroundColor: "#450a0a",
    padding: 16,
    marginBottom: 16,
  },
  bannerTitle: {
    color: "#fecaca",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  bannerText: {
    color: "#fee2e2",
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    marginBottom: 16,
    color: "#f8fafc",
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  secondaryButton: {
    backgroundColor: "#059669",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 18,
  },
  outlineButton: {
    borderWidth: 1,
    borderColor: "#475569",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 16,
  },
  outlineButtonText: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "600",
  },
  signOutButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 14,
    alignItems: "center",
  },
  signOutText: {
    color: "#cbd5e1",
    fontSize: 14,
    fontWeight: "600",
  },
  disabledButton: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
  idCard: {
    marginTop: 24,
    backgroundColor: "#111827",
    padding: 20,
    borderRadius: 16,
    borderLeftWidth: 4,
    borderLeftColor: "#10b981",
  },
  idLabel: {
    fontSize: 10,
    color: "#6ee7b7",
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 6,
    letterSpacing: 1.2,
  },
  idHeading: {
    fontSize: 18,
    color: "#f8fafc",
    fontWeight: "700",
    marginBottom: 8,
  },
  idValue: {
    fontSize: 14,
    color: "#bfdbfe",
    fontWeight: "700",
  },
  idMeta: {
    marginTop: 10,
    color: "#94a3b8",
    fontSize: 13,
  },
  idSubtext: {
    fontSize: 12,
    color: "#60a5fa",
    fontWeight: "700",
    textAlign: "center",
    marginTop: 4,
  },
  locationStatus: {
    fontSize: 12,
    color: "#94a3b8",
    marginTop: 6,
    textAlign: "center",
  },
  accountCard: {
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 18,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  accountTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  accountMeta: {
    color: "#94a3b8",
    fontSize: 13,
    marginBottom: 4,
  },
  scoreCard: {
    backgroundColor: "#111827",
    padding: 32,
    borderRadius: 18,
    alignItems: "center",
    marginBottom: 20,
  },
  scoreLabel: {
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: "700",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  scoreValue: {
    fontSize: 56,
    fontWeight: "900",
  },
  scoreSubtitle: {
    fontSize: 12,
    color: "#94a3b8",
    marginTop: 8,
  },
  infoCard: {
    backgroundColor: "#1e293b",
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  infoTitle: {
    fontSize: 15,
    color: "#f8fafc",
    fontWeight: "700",
    marginBottom: 8,
  },
  infoText: {
    color: "#cbd5e1",
    fontSize: 13,
    lineHeight: 20,
  },
  panicButton: {
    backgroundColor: "#dc2626",
    borderRadius: 18,
    padding: 20,
    alignItems: "center",
    marginBottom: 16,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  panicText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 0.8,
  },
});
