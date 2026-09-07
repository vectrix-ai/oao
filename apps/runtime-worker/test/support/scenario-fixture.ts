import { inspect } from "node:util";
import { withScenarioCleanup } from "./isolated-scenario.js";

const mode = process.argv[2];
if (mode === "success") {
  process.exit(0);
} else if (mode === "timeout") {
  console.error("scenario is still active");
  setInterval(() => {}, 1_000);
} else if (mode === "failure") {
  setInterval(() => {}, 1_000);
  void withScenarioCleanup(async () => {
    throw new Error("original assertion");
  }, [
    async () => {
      throw new Error("cleanup refused active work");
    },
  ]).catch((error: unknown) => {
    process.stderr.write(`${inspect(error)}\n`, () => process.exit(1));
  });
} else {
  throw new Error("Unknown scenario fixture");
}
