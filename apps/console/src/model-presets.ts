import type { ModelPreset, ModelRoutingPolicy } from "./api/types";

/** Mirrors the server contract for stable, versioned model preset keys. */
export const MODEL_PRESET_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]{0,4}$/u;

/** Renders the provider-neutral routing policy as one readable sentence. */
export function describeRouting(routing: ModelRoutingPolicy): string {
  const parts: string[] = [];
  if (routing.dataCollection)
    parts.push(`data collection ${routing.dataCollection}`);
  if (routing.zeroDataRetention) parts.push("zero data retention");
  if (routing.allowFallbacks === false) parts.push("no fallbacks");
  if (routing.requireParameters) parts.push("require parameters");
  if (routing.providerAllowlist)
    parts.push(`only ${routing.providerAllowlist.join(", ")}`);
  if (routing.providerDenylist)
    parts.push(`never ${routing.providerDenylist.join(", ")}`);
  if (routing.providerOrder)
    parts.push(`order ${routing.providerOrder.join(" › ")}`);
  if (routing.sort) parts.push(`prefer ${routing.sort}`);
  if (routing.maxPromptPriceUsdPerMillion !== undefined)
    parts.push(`prompt ≤ $${routing.maxPromptPriceUsdPerMillion}/M`);
  if (routing.maxCompletionPriceUsdPerMillion !== undefined)
    parts.push(`completion ≤ $${routing.maxCompletionPriceUsdPerMillion}/M`);
  return parts.length === 0 ? "Provider defaults" : parts.join(" · ");
}

/** Deployment routing remains operator-managed and is not fully public. */
export function describePresetRouting(preset: ModelPreset): string {
  if (preset.origin === "deployment" && preset.hosted)
    return "Deployment-managed routing";
  if (preset.settings)
    return `${preset.settings.mode} · ${preset.settings.effort} reasoning · ${preset.settings.verbosity} verbosity · ${preset.settings.summary} summary`;
  return describeRouting(preset.routing);
}

/**
 * Suggests a preset key from a catalog model name.
 *
 * Preset rows are append-only, so the suffix walks forward to the first
 * version that is still free instead of proposing a key that already exists.
 */
export function suggestPresetKey(
  modelName: string,
  existingKeys: readonly string[],
): string {
  const slug = modelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replace(/-+$/gu, "");
  const base = /^[a-z]/u.test(slug) ? slug : `model${slug ? `-${slug}` : ""}`;
  for (let version = 1; version <= 99; version += 1) {
    const candidate = `${base}-v${version}`;
    if (!existingKeys.includes(candidate)) return candidate;
  }
  return "";
}
