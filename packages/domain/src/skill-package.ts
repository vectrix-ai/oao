interface SkillPackageHashInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowedTools?: string;
  readonly files: readonly {
    readonly path: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }[];
}

const compareCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Version 2 is independent of process locale, ICU collation and database order. */
export function serializeSkillPackageForHash(
  input: SkillPackageHashInput,
): string {
  return serialize(input, 2, compareCodeUnits);
}

/** Read-only compatibility with v1 publications from the original en-US runtime.
 * Pin its locale explicitly: never use the receiving worker's default locale.
 * New publications always use v2; old immutable rows do not need rewriting.
 */
export function serializeLegacySkillPackageForHash(
  input: SkillPackageHashInput,
): string {
  return serialize(input, 1, (a, b) => a.localeCompare(b, "en-US"));
}

function serialize(
  input: SkillPackageHashInput,
  version: number,
  compare: (a: string, b: string) => number,
): string {
  return stableJson(
    {
      ...input,
      schemaVersion: version,
      files: [...input.files].sort((a, b) => compare(a.path, b.path)),
    },
    compare,
  );
}

function stableJson(
  value: unknown,
  compare: (a: string, b: string) => number,
): string {
  if (Array.isArray(value))
    return `[${value.map((v) => stableJson(v, compare)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${stableJson(nested, compare)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
