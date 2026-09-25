import type { ConfigContext, ExpoConfig } from "expo/config";
import { config } from "dotenv";

config({ path: ".env.hotupdater", quiet: true });

const hotUpdaterApiKey =
  process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY?.trim() || process.env.HOT_UPDATER_API_KEY?.trim();

export default function appConfig(_context: ConfigContext): ExpoConfig {
  const otaEnabled = process.env.EXPO_PUBLIC_RELAY_OTA_ENABLED === "1";
  const otaPublicKeyPath = process.env.RELAY_OTA_PUBLIC_KEY_PATH;
  if (otaEnabled && !otaPublicKeyPath) throw new Error("Own OTA signing public key is required.");
  if (otaEnabled) {
    const endpoint = new URL(process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL ?? "");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error("Own OTA endpoint must use HTTPS without URL credentials.");
    }
  }
  const expoProjectId = process.env.RELAY_EXPO_PROJECT_ID?.trim();
  return {
    name: "Ari Relay",
    slug: "ari-relay",
    version: "1.5.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "ari-relay",
    userInterfaceStyle: "automatic",
    ios: {
      icon: "./assets/images/icon.png",
      bundleIdentifier: "de.silkrock.arirelay",
      deploymentTarget: "16.4",
      supportsTablet: true,
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: true,
        },
        ITSAppUsesNonExemptEncryption: false,
        NSLocalNetworkUsageDescription:
          "Codex Relay uses the local network to connect this device to the Codex Relay server running on your computer.",
        "UISupportedInterfaceOrientations~ipad": [
          "UIInterfaceOrientationPortrait",
          "UIInterfaceOrientationPortraitUpsideDown",
          "UIInterfaceOrientationLandscapeLeft",
          "UIInterfaceOrientationLandscapeRight",
        ],
      },
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#191919",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      package: "de.silkrock.arirelay",
      permissions: ["android.permission.CAMERA", "android.permission.POST_NOTIFICATIONS"],
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-dev-client",
        {
          launchMode: "most-recent",
        },
      ],
      [
        "expo-splash-screen",
        {
          backgroundColor: "#191919",
          image: "./assets/images/splash-icon.png",
          imageWidth: 112,
          android: {
            image: "./assets/images/splash-icon.png",
            imageWidth: 112,
          },
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "Codex Relay uses the camera to scan QR codes that contain your local relay server address, for example to connect this device to the Codex Relay server running on your computer.",
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission:
            "Codex Relay uses photo library access so you can attach images to a Codex chat, for example to ask Codex to inspect a screenshot.",
          microphonePermission: false,
        },
      ],
      "expo-font",
      "expo-image",
      "expo-notifications",
      "expo-system-ui",
      "expo-web-browser",
      ...(otaEnabled
        ? [
            ["@hot-updater/expo", { channel: "production", publicKeyPath: otaPublicKeyPath }] as [
              string,
              Record<string, unknown>,
            ],
          ]
        : []),
      [
        "expo-secure-store",
        {
          faceIDPermission: false,
        },
      ],
      [
        "expo-build-properties",
        {
          android: {
            usesCleartextTraffic: false,
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      hotUpdaterApiKey,
      router: {},
      ...(expoProjectId ? { eas: { projectId: expoProjectId } } : {}),
    },
  };
}
