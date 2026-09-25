import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useRef } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

type Tone = "steel" | "emerald" | "amber";

type Props = {
  accessibilityLabel?: string;
  compact?: boolean;
  detail?: string;
  disabled?: boolean;
  glyph: string;
  label: string;
  onPress: () => void;
  tone?: Tone;
};

const gradients: Record<Tone, readonly [string, string, string]> = {
  steel: ["#eef2f3", "#aab3b8", "#626d73"],
  emerald: ["#c6e4d2", "#5c9272", "#28543b"],
  amber: ["#f5dba8", "#b17b2d", "#6b4114"],
};

export function AtlasButton({
  accessibilityLabel,
  compact = false,
  detail,
  disabled = false,
  glyph,
  label,
  onPress,
  tone = "steel",
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (toValue: number, release = false) => {
    Animated.spring(scale, {
      damping: release ? 11 : 18,
      mass: release ? 0.58 : 0.42,
      stiffness: release ? 255 : 360,
      toValue,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[styles.animatedFrame, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityRole="button"
        android_ripple={{ color: "rgba(255,255,255,0.18)" }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => {
          animate(0.965);
          void Haptics.selectionAsync();
        }}
        onPressOut={() => animate(1, true)}
        style={[styles.pressable, disabled && styles.disabled]}
      >
        <LinearGradient
          colors={gradients[tone]}
          end={{ x: 0, y: 1 }}
          start={{ x: 0, y: 0 }}
          style={[styles.face, compact && styles.faceCompact]}
        >
          <View pointerEvents="none" style={styles.gloss} />
          <View style={[styles.glyphWell, compact && styles.glyphWellCompact]}>
            <Text style={[styles.glyph, compact && styles.glyphCompact]}>
              {glyph}
            </Text>
          </View>
          <View style={styles.copy}>
            <Text numberOfLines={1} style={styles.label}>
              {label}
            </Text>
            {detail && !compact ? (
              <Text numberOfLines={1} style={styles.detail}>
                {detail}
              </Text>
            ) : null}
          </View>
          <Text style={styles.chevron}>›</Text>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  animatedFrame: {
    borderColor: "#171d1f",
    borderRadius: Platform.select({ ios: 11, android: 8 }),
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.48,
    shadowRadius: 4,
    elevation: 7,
  },
  pressable: {
    borderRadius: Platform.select({ ios: 10, android: 7 }),
    overflow: "hidden",
  },
  disabled: {
    opacity: 0.43,
  },
  face: {
    alignItems: "center",
    borderColor: "rgba(255,255,255,0.58)",
    borderRadius: Platform.select({ ios: 10, android: 7 }),
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 56,
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  faceCompact: {
    minHeight: 44,
    paddingVertical: 4,
  },
  gloss: {
    backgroundColor: "rgba(255,255,255,0.22)",
    borderBottomColor: "rgba(255,255,255,0.14)",
    borderBottomWidth: 1,
    height: "47%",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  glyphWell: {
    alignItems: "center",
    backgroundColor: "rgba(12,18,19,0.72)",
    borderColor: "rgba(255,255,255,0.33)",
    borderRadius: Platform.select({ ios: 8, android: 5 }),
    borderWidth: 1,
    height: 39,
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.8,
    shadowRadius: 1,
    width: 39,
  },
  glyph: {
    color: "#f2ead8",
    fontSize: 22,
    fontWeight: "800",
    marginTop: -1,
    textShadowColor: "#000",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  glyphWellCompact: {
    borderRadius: 6,
    height: 31,
    width: 31,
  },
  glyphCompact: {
    fontSize: 18,
  },
  copy: {
    flex: 1,
    marginLeft: 11,
  },
  label: {
    color: "#111719",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.1,
    textShadowColor: "rgba(255,255,255,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 0,
  },
  detail: {
    color: "rgba(10,16,18,0.73)",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 1,
  },
  chevron: {
    color: "rgba(12,18,19,0.72)",
    fontSize: 30,
    fontWeight: "300",
    marginLeft: 7,
    marginTop: -2,
  },
});
