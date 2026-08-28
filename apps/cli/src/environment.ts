import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface SetupState {
  readonly schemaVersion: 1;
  readonly setupId: string;
  readonly providerType?: "openrouter" | "openai" | "anthropic" | "xai";
  readonly providerId?: string;
  readonly presetId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface LocalEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly created: boolean;
  readonly encryptionKeyGenerated: boolean;
}

function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    values[key] = rawValue.replace(/^(['"])(.*)\1$/u, "$2").trim();
  }
  return values;
}

function validEncryptionKey(value: string): boolean {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function ensureLocalEnvironment(
  repositoryRoot: string,
): Promise<LocalEnvironment> {
  const envPath = resolve(repositoryRoot, ".env");
  const examplePath = resolve(repositoryRoot, ".env.example");
  const created = !(await exists(envPath));
  let contents = created
    ? await readFile(examplePath, "utf8")
    : await readFile(envPath, "utf8");
  const before = parseDotEnv(contents);
  const existingKey = before.OAO_CREDENTIAL_ENCRYPTION_KEY;
  if (existingKey && !validEncryptionKey(existingKey)) {
    throw new Error(
      "Existing OAO_CREDENTIAL_ENCRYPTION_KEY is not a canonical base64-encoded 32-byte key; setup will not replace it",
    );
  }
  let encryptionKeyGenerated = false;
  if (!existingKey) {
    const generated = randomBytes(32).toString("base64");
    const pattern = /^OAO_CREDENTIAL_ENCRYPTION_KEY=.*$/mu;
    contents = pattern.test(contents)
      ? contents.replace(pattern, `OAO_CREDENTIAL_ENCRYPTION_KEY=${generated}`)
      : `${contents.trimEnd()}\nOAO_CREDENTIAL_ENCRYPTION_KEY=${generated}\n`;
    encryptionKeyGenerated = true;
  }
  if (created || encryptionKeyGenerated) await atomicWrite(envPath, contents);
  else await chmod(envPath, 0o600);
  return {
    values: parseDotEnv(contents),
    created,
    encryptionKeyGenerated,
  };
}

export async function loadSetupState(
  repositoryRoot: string,
): Promise<SetupState> {
  const path = resolve(repositoryRoot, ".oao/setup-state.json");
  if (!(await exists(path))) {
    return { schemaVersion: 1, setupId: randomUUID() };
  }
  const parsed = JSON.parse(
    await readFile(path, "utf8"),
  ) as Partial<SetupState>;
  if (parsed.schemaVersion !== 1 || typeof parsed.setupId !== "string") {
    throw new Error(".oao/setup-state.json has an unsupported format");
  }
  return parsed as SetupState;
}

export async function saveSetupState(
  repositoryRoot: string,
  state: SetupState,
): Promise<void> {
  await atomicWrite(
    resolve(repositoryRoot, ".oao/setup-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export { parseDotEnv, validEncryptionKey };
