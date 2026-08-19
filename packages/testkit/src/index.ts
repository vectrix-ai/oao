import type {
  Brand,
  ClockPort,
  IdPort,
  ModelPort,
  ModelRequest,
  ModelResponse,
  OrganizationId,
  Principal,
  PrincipalId,
  ProjectId,
  SandboxPort,
} from "@oao/domain";
import { brandedId } from "@oao/domain";

export class DeterministicClock implements ClockPort {
  #current: Date;
  constructor(start = new Date("2026-01-01T00:00:00.000Z")) {
    this.#current = new Date(start);
  }
  now(): Date {
    return new Date(this.#current);
  }
  advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }
}

export class DeterministicIds implements IdPort {
  #next = 1;
  next<T extends Brand<string, string>>(): T {
    const suffix = this.#next.toString(16).padStart(12, "0");
    this.#next += 1;
    return brandedId<T>(`00000000-0000-4000-8000-${suffix}`);
  }
}

export function deterministicPrincipal(
  overrides: Partial<Principal> = {},
): Principal {
  return {
    id: brandedId<PrincipalId>("00000000-0000-4000-8000-000000000003"),
    organizationId: brandedId<OrganizationId>(
      "00000000-0000-4000-8000-000000000001",
    ),
    projectId: brandedId<ProjectId>("00000000-0000-4000-8000-000000000002"),
    kind: "human",
    subject: "development-user",
    scopes: new Set(["*"]),
    ...overrides,
  };
}

export class FakeModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  #responses: ModelResponse[];
  constructor(responses: readonly ModelResponse[] = []) {
    this.#responses = [...responses];
  }
  async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return (
      this.#responses.shift() ?? {
        redactedText: "deterministic response",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    );
  }
}

export class FakeSandbox implements SandboxPort {
  readonly calls: string[] = [];
  async create(): Promise<{ readonly sandboxRef: string }> {
    this.calls.push("create");
    return { sandboxRef: "sandbox_test" };
  }
  async execute(input: {
    readonly command: string;
  }): Promise<{ readonly exitCode: number; readonly redactedOutput: string }> {
    this.calls.push(`execute:${input.command}`);
    return { exitCode: 0, redactedOutput: "ok" };
  }
  async stop(sandboxRef: string): Promise<void> {
    this.calls.push(`stop:${sandboxRef}`);
  }
}

export type CrashPoint =
  | "before_obligation"
  | "after_obligation"
  | "after_provider"
  | "before_commit"
  | "after_commit";
export class CrashBarrier extends Error {
  readonly reached: CrashPoint[] = [];
  #armed: CrashPoint | undefined;
  arm(point: CrashPoint): void {
    this.#armed = point;
  }
  async reach(point: CrashPoint): Promise<void> {
    this.reached.push(point);
    if (this.#armed === point) {
      this.#armed = undefined;
      throw new SimulatedCrash(point);
    }
  }
}

export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`Simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}
