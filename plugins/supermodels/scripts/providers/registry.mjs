import { providerDefinition as claude } from "./claude/adapter.mjs";
import { providerDefinition as antigravity } from "./antigravity/adapter.mjs";
import { providerDefinition as grok } from "./grok/adapter.mjs";

export const PROVIDER_DEFINITIONS = Object.freeze([
  claude,
  antigravity,
  grok,
]);

export const PROVIDER_IDS = Object.freeze(
  PROVIDER_DEFINITIONS.map((provider) => provider.id),
);

const PROVIDER_BY_ID = new Map(
  PROVIDER_DEFINITIONS.map((provider) => [provider.id, provider]),
);
const PROVIDER_ID_BY_NAME = new Map(
  PROVIDER_DEFINITIONS.flatMap((provider) => [
    [provider.id, provider.id],
    ...provider.aliases.map((alias) => [alias, provider.id]),
  ]),
);

export function resolveProviderId(value) {
  return PROVIDER_ID_BY_NAME.get(String(value ?? "").trim().toLowerCase()) ?? "";
}

export function providerLabel(provider) {
  const value = String(provider ?? "");
  const challenge = parseChallengeProvider(value);
  if (challenge) {
    const targets = challenge.targets.map((target) => providerLabel(target)).join(", ");
    return `${providerLabel(challenge.source)} challenging ${targets}`;
  }
  const id = resolveProviderId(value);
  return id ? PROVIDER_BY_ID.get(id).label : value;
}

export function challengeRunId(provider, targets) {
  const encodedTargets = Buffer.from(JSON.stringify(targets), "utf8").toString("base64url");
  return `${provider}-challenge-v2-${encodedTargets}`;
}

export function createProviderAdapters(optionsByProvider = {}) {
  return Object.fromEntries(
    PROVIDER_DEFINITIONS.map((provider) => [
      provider.id,
      provider.create(optionsByProvider[provider.id] ?? {}),
    ]),
  );
}

function parseChallengeProvider(provider) {
  const marker = "-challenge-";
  const markerIndex = provider.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const source = provider.slice(0, markerIndex);
  const targetValue = provider.slice(markerIndex + marker.length);
  if (!source || !targetValue) {
    return null;
  }
  if (targetValue.startsWith("v2-")) {
    try {
      const targets = JSON.parse(Buffer.from(targetValue.slice(3), "base64url").toString("utf8"));
      if (Array.isArray(targets) && targets.length && targets.every((target) => typeof target === "string" && target)) {
        return { source, targets };
      }
    } catch {
      return null;
    }
    return null;
  }
  // Preserve labels for artifacts written before the unambiguous v2 encoding.
  return { source, targets: targetValue.split("-").filter(Boolean) };
}
