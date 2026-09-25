import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";

import { ChatScreen } from "@/components/chat/ChatScreen";
import { IpadSplitLayoutProvider } from "@/components/chat/ipad-split-layout";

export default function PairScreen() {
  const params = useLocalSearchParams();
  const initialPairingUrl = useMemo(() => pairingUrlFromParams(params), [params]);

  return (
    <IpadSplitLayoutProvider>
      <ChatScreen initialPairingUrl={initialPairingUrl} />
    </IpadSplitLayoutProvider>
  );
}

function pairingUrlFromParams(params: Record<string, string | string[]>) {
  const serverUrl = firstParam(params.serverUrl);
  const serverPublicKey = firstParam(params.serverPublicKey);
  if (!serverUrl || !serverPublicKey) {
    return null;
  }

  const pairingUrl = new URL("ari-relay://pair");
  pairingUrl.searchParams.set("serverUrl", serverUrl);
  pairingUrl.searchParams.set("serverPublicKey", serverPublicKey.replaceAll(" ", "+"));
  for (const key of ["h", "serverHosts", "serverUrls"]) {
    const value = firstParam(params[key]);
    if (value) {
      pairingUrl.searchParams.set(key, value);
    }
  }
  return pairingUrl.toString();
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
