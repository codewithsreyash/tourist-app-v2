import React from "react";
import { StyleSheet, Text, View } from "react-native";

function getBannerAppearance(status) {
  switch (status) {
    case "Live":
      return {
        backgroundColor: "rgba(22, 163, 74, 0.16)",
        borderColor: "rgba(74, 222, 128, 0.35)",
        textColor: "#bbf7d0",
        title: "Live",
      };
    case "Reconnecting":
      return {
        backgroundColor: "rgba(217, 119, 6, 0.18)",
        borderColor: "rgba(251, 191, 36, 0.35)",
        textColor: "#fde68a",
        title: "Reconnecting...",
      };
    case "Connecting":
      return {
        backgroundColor: "rgba(29, 78, 216, 0.18)",
        borderColor: "rgba(96, 165, 250, 0.35)",
        textColor: "#bfdbfe",
        title: "Connecting...",
      };
    default:
      return {
        backgroundColor: "rgba(220, 38, 38, 0.18)",
        borderColor: "rgba(248, 113, 113, 0.35)",
        textColor: "#fecaca",
        title: "Offline",
      };
  }
}

export function ConnectionBanner({ status, queueSize = 0 }) {
  const appearance = getBannerAppearance(status);
  const detail =
    queueSize > 0
      ? `${queueSize} update${queueSize === 1 ? "" : "s"} queued for sync`
      : status === "Live"
        ? "Realtime safety link active"
        : "Realtime safety link temporarily unavailable";

  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: appearance.backgroundColor,
          borderColor: appearance.borderColor,
        },
      ]}
    >
      <Text style={[styles.title, { color: appearance.textColor }]}>{appearance.title}</Text>
      <Text style={styles.detail}>{detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 16,
  },
  title: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 2,
  },
  detail: {
    color: "#e2e8f0",
    fontSize: 12,
  },
});
