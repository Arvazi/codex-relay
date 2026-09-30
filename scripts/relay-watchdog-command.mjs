export function relayServiceCommand(cliArgs) {
  const persistent = !cliArgs.includes("stop");
  return {
    command: "pnpm",
    args: [
      "--filter",
      "codex-relay",
      "exec",
      "tsx",
      ...(persistent ? ["watch"] : []),
      "src/cli.ts",
      ...cliArgs,
    ],
    persistent,
  };
}

// Keep in sync with defaultCodexRelayPort in packages/codex-relay/src/api-schema.ts.
const defaultRelayPort = "8790";

export function relayPort(env = process.env) {
  return env.CODEX_RELAY_PORT ?? env.PORT ?? defaultRelayPort;
}

export function relayHealthUrl(env = process.env) {
  const host = env.RELAY_HEALTH_CHECK_HOST ?? "127.0.0.1";
  const port = relayPort(env);
  return `http://${host}:${port}/version`;
}

export async function isRelayHealthy(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { method: "GET" });
    if (!response.ok) {
      return false;
    }
    const body = await response.json();
    return isRelayVersionResponse(body);
  } catch {
    return false;
  }
}

function isRelayVersionResponse(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "service" in value &&
    value.service === "codex-relay-server"
  );
}
