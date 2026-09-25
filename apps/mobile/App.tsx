import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { GameSurface } from "./src/GameSurface";

export default function App() {
  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar animated style="light" />
        <GameSurface />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#05090c",
  },
});
