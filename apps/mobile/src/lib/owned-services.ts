export const ownedOtaEnabled =
  process.env.EXPO_PUBLIC_RELAY_OTA_ENABLED === "1" &&
  Boolean(process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL?.trim());
