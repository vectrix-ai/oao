import type { Provider } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { deepFreeze } from "./providers/shared.js";

export function withPlatformTurnLimit<T extends Provider>(
  provider: T,
  maxTurns = 32,
): T {
  const assertTurnLimit = (messages: readonly { readonly role: string }[]) => {
    let boundary = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        boundary = index;
        break;
      }
    }
    const turns = messages
      .slice(boundary + 1)
      .filter((message) => message.role === "assistant").length;
    if (turns >= maxTurns)
      throw new Error(`Platform model turn limit exceeded (${maxTurns})`);
  };
  return {
    ...provider,
    stream(model, context, options) {
      assertTurnLimit(context.messages);
      return provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      assertTurnLimit(context.messages);
      return provider.streamSimple(model, context, options);
    },
  } as T;
}

export function createDeterministicModelProvider(
  responses?: readonly FauxResponseStep[],
): FauxProviderHandle {
  const handle = fauxProvider({
    provider: "fake",
    api: "fake",
    models: [
      {
        id: "deterministic",
        name: "OAO deterministic fake",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    tokensPerSecond: 0,
  });
  if (responses) {
    handle.setResponses([...responses]);
  } else {
    const repeat: FauxResponseStep = (_context, _options, state) => {
      handle.appendResponses([repeat]);
      return fauxAssistantMessage("deterministic response", {
        responseId: `oao-fake-response-${state.callCount}`,
      });
    };
    handle.setResponses([repeat]);
  }
  return handle;
}

/** Test-only deterministic preset. Runnable OAO processes do not load it. */
export const DEFAULT_LOCAL_PRESETS = deepFreeze([
  { key: "local-default", model: "fake/deterministic" },
]);
