import {
  AUTHORIZATION_SCOPE_CATALOG,
  OAO_AGENT_TOOL_SCOPES,
  type ManagedAgentOaoTools,
  type OaoAgentToolScope,
} from "@oao/contracts";

import type { AgentVersionConfig } from "../api/types";
import { CheckboxRow, Field, Select } from "../components/ui";

const SCOPE_DESCRIPTIONS = new Map<string, string>(AUTHORIZATION_SCOPE_CATALOG);

/** A sensible first grant: read the project and ask other agents. */
const DEFAULT_SCOPES: readonly OaoAgentToolScope[] = [
  "agent:read",
  "session:read",
  "run:read",
  "run:create",
];

export function defaultOaoToolGrant(): ManagedAgentOaoTools {
  return { scopes: [...DEFAULT_SCOPES], approval: "always" };
}

/** The config without its OAO tool grant, for the caller to set itself. */
export function withoutOaoTools(
  config: AgentVersionConfig,
): AgentVersionConfig {
  const copy: { -readonly [Key in keyof AgentVersionConfig]?: unknown } = {
    ...config,
  };
  delete copy.oaoTools;
  return copy as AgentVersionConfig;
}

/** One line on what an agent's grant allows. */
export function describeOaoToolGrant(grant: ManagedAgentOaoTools): string {
  return `${grant.scopes.length} ${grant.scopes.length === 1 ? "scope" : "scopes"}${
    grant.approval === "always" ? "; changes wait for approval" : ""
  }`;
}

/** Chooses the scopes and approval of an agent's OAO MCP server tools. */
export function OaoToolGrantFields({
  grant,
  disabled = false,
  onChange,
}: {
  readonly grant: ManagedAgentOaoTools;
  readonly disabled?: boolean;
  readonly onChange: (grant: ManagedAgentOaoTools) => void;
}) {
  return (
    <>
      <Field label="Changes to OAO">
        <Select
          value={grant.approval}
          disabled={disabled}
          onChange={(event) => {
            const approval =
              event.currentTarget.value === "never" ? "never" : "always";
            onChange({ ...grant, approval });
          }}
        >
          <option value="always">Wait for a person to approve</option>
          <option value="never">Run without approval</option>
        </Select>
      </Field>
      <fieldset className="scope-picker">
        <legend>OAO tool scopes</legend>
        <span className="hint">
          The agent acts as the person or key that started its run, limited to
          these scopes. You can grant only scopes you hold. Approving tool calls
          and project administration are never available to an agent.
        </span>
        <div className="scope-picker-grid">
          {OAO_AGENT_TOOL_SCOPES.map((scope) => (
            <CheckboxRow
              key={scope}
              label={scope}
              description={SCOPE_DESCRIPTIONS.get(scope) ?? ""}
              checked={grant.scopes.includes(scope)}
              disabled={
                disabled ||
                (grant.scopes.length === 1 && grant.scopes.includes(scope))
              }
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                onChange({
                  ...grant,
                  scopes: checked
                    ? [...grant.scopes, scope]
                    : grant.scopes.filter((item) => item !== scope),
                });
              }}
            />
          ))}
        </div>
      </fieldset>
    </>
  );
}
