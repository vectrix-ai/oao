import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import type { PrincipalId } from "@oao/domain";
import { startRuntimeWorker } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const fakeResponse: FauxResponseStep = (context) => {
  const transcript = JSON.stringify(context.messages);
  if (!transcript.includes("caller-tool exact"))
    throw new Error("Unexpected child fake-model scenario");
  if (context.messages.some((message) => message.role === "toolResult"))
    return fauxAssistantMessage("finished:caller-tool exact");
  return fauxAssistantMessage(
    [fauxToolCall("caller.lookup", { query: "caller-tool exact" })],
    { stopReason: "toolUse" },
  );
};

const worker = await startRuntimeWorker({
  databaseUrl,
  listen: false,
  env: {
    ...process.env,
    OAO_RUNTIME_SERVICE_PRINCIPAL_ID:
      "00000000-0000-4000-8000-000000000099" as PrincipalId,
    OAO_SANDBOX_PROVIDER: "fake",
  },
  fakeResponses: Array.from({ length: 16 }, () => fakeResponse),
});

process.send?.({ type: "ready" });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const forcedExit = setTimeout(() => process.exit(0), 10_000);
  await worker.prepareProcessHandoff().finally(() => {
    clearTimeout(forcedExit);
    process.exit(0);
  });
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
