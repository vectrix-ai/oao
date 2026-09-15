/** The original publication ordering is retained for immutable v1 hashes. */
export function serializeSkillPackageForHash(input: {
  readonly schemaVersion: number;
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
}): string {
  return stableJson({
    ...input,
    // Never hash database collation order. Both publication and activation use
    // the same JS ordering, including packages published before this helper.
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
