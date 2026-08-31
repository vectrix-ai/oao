import { QueryClient } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ConsoleApp } from "../src/app";
import { DemoConsoleApi } from "../src/api/context";

/** Editor sections other than the definition start collapsed; open one by its heading. */
async function openSection(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<void> {
  const toggle = await screen.findByRole("button", { name });
  if (toggle.getAttribute("aria-expanded") !== "true") await user.click(toggle);
}

function renderConsole(
  path: string,
  api = new DemoConsoleApi({ eventDelayMs: 60_000 }),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return {
    api,
    queryClient,
    ...render(
      <MemoryRouter initialEntries={[path]}>
        <ConsoleApp api={api} queryClient={queryClient} />
      </MemoryRouter>,
    ),
  };
}

describe("management console", () => {
  it("shows WorkOS display metadata and provides logout", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    vi.spyOn(api, "getContext").mockResolvedValue({
      organization: { id: "org-1", name: "OAO" },
      project: { id: "project-1", name: "Managed agents" },
      currentPrincipal: {
        id: "principal-1",
        kind: "human",
        subject: "development-user",
        displayName: "Ben Selleslagh",
        role: "Platform owner",
        scopes: ["*"],
      },
      organizations: [{ id: "org-1", name: "OAO" }],
      projects: [{ id: "project-1", name: "Managed agents" }],
      authProvider: "workos",
    });
    const logout = vi.spyOn(api, "logout").mockResolvedValue();

    renderConsole("/agents", api);
    expect(await screen.findByText("Ben Selleslagh")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("renders real organization and current-project metadata without placeholder actions", async () => {
    const { unmount } = renderConsole("/organization");
    expect(
      await screen.findByRole("heading", { name: "Organization" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Example operations")).toHaveLength(2);
    expect(
      screen.getByText("11111111-1111-4111-8111-111111111111"),
    ).toBeInTheDocument();
    unmount();

    renderConsole("/projects");
    expect(
      await screen.findByRole("heading", { name: "Projects" }),
    ).toBeInTheDocument();
    expect(screen.getByText("managed-agents")).toBeInTheDocument();
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New project" }),
    ).not.toBeInTheDocument();
  });

  it("adds, changes, and removes project members", async () => {
    const user = userEvent.setup();
    renderConsole("/members");
    expect(await screen.findByText("Demo Operator")).toBeInTheDocument();
    expect(screen.getByLabelText("Role for Demo Operator")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add member" }));
    const add = within(
      screen.getByRole("dialog", { name: "Add project member" }),
    );
    await user.type(
      add.getByLabelText("Principal subject"),
      "new.reviewer@example.test",
    );
    await user.selectOptions(add.getByLabelText("Project role"), "viewer");
    await user.click(add.getByRole("button", { name: "Add member" }));

    const memberName = await screen.findByText("new reviewer");
    const row = memberName.closest("tr");
    expect(row).not.toBeNull();
    if (!row) throw new Error("New member row was not rendered");
    await user.selectOptions(
      within(row).getByRole("combobox", { name: "Role for new reviewer" }),
      "member",
    );
    await waitFor(() =>
      expect(
        within(row).getByRole("combobox", { name: "Role for new reviewer" }),
      ).toHaveValue("member"),
    );

    await user.click(within(row).getByRole("button", { name: "Remove" }));
    const remove = within(
      screen.getByRole("dialog", { name: "Remove new reviewer" }),
    );
    await user.click(remove.getByRole("button", { name: "Remove member" }));
    await waitFor(() =>
      expect(screen.queryByText("new reviewer")).not.toBeInTheDocument(),
    );
  });

  // The neo-brutalist system is light-only: dark is composed with ink blocks
  // inside a light page, never as a `data-theme` variant, so the console must
  // not offer an appearance toggle.
  it("renders a single light appearance with no theme toggle", async () => {
    renderConsole("/agents");
    expect(
      await screen.findByRole("heading", { name: "Agents" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /appearance/i }),
    ).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("lists agents and applies search filters", async () => {
    const user = userEvent.setup();
    renderConsole("/agents");
    expect(
      await screen.findByRole("heading", { name: "Agents" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Support operator")).toBeInTheDocument();
    expect(await screen.findByText("Demo Operator")).toBeInTheDocument();
    expect(screen.getByText("Platform Owner")).toBeInTheDocument();
    await user.type(
      screen.getByRole("searchbox", { name: "Search agents" }),
      "not-a-real-agent",
    );
    expect(
      await screen.findByRole("heading", { name: "No matching agents" }),
    ).toBeInTheDocument();
  });

  it("deletes an agent from the list after confirmation", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents", api);
    expect(await screen.findByText("Order triage")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete agent Order triage" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Delete “Order triage”?",
    });
    expect(
      within(dialog).getByText(/Existing sessions keep their transcripts/u),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Delete agent" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Order triage")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Support operator")).toBeInTheDocument();
    await expect(
      api.getAgent("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    ).rejects.toThrow("Agent not found");
  });

  it("deletes an agent from its detail page and returns to the list", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents/cccccccc-cccc-4ccc-8ccc-cccccccccccc", api);
    await screen.findByRole("heading", { name: "Order triage" });
    // Cancelling leaves the agent untouched.
    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Delete “Order triage”?" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Delete “Order triage”?" }),
      ).getByRole("button", { name: "Delete agent" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Agents" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Order triage")).not.toBeInTheDocument();
  });

  it("creates the first agent version with the selected model preset", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents", api);
    await user.click(
      await screen.findByRole("button", { name: "Create agent" }),
    );
    const dialog = within(screen.getByRole("dialog", { name: "Create agent" }));
    await user.type(dialog.getByLabelText("Name"), "Hosted reviewer");
    await user.type(
      dialog.getByLabelText("Description"),
      "Reviews requests with the hosted model preset.",
    );
    await user.click(
      dialog.getByRole("checkbox", { name: /Shipment Intake · v1/u }),
    );
    const preset = dialog.getByRole("combobox", {
      name: /^Approved model preset/u,
    });
    await user.click(preset);
    await user.type(preset, "zero retention");
    await user.click(
      await dialog.findByRole("option", {
        name: /Claude Sonnet 4\.6 \(zero retention\)/u,
      }),
    );
    expect(
      await dialog.findByText("openrouter/anthropic/claude-sonnet-4.6"),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole("checkbox", { name: "Enable sandbox" }));
    await user.selectOptions(
      dialog.getByLabelText("Sandbox provider"),
      "daytona-primary",
    );
    await dialog.findByRole("option", { name: /daytona-small/u });
    await user.selectOptions(
      dialog.getByLabelText("Daytona snapshot"),
      "77777777-7777-4777-8777-777777777777",
    );
    await user.selectOptions(
      dialog.getByLabelText("Network policy"),
      "restricted",
    );
    await user.click(dialog.getByRole("button", { name: "Create agent" }));
    expect(
      await screen.findByRole("heading", { name: "Hosted reviewer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("openrouter/anthropic/claude-sonnet-4.6"),
    ).toBeInTheDocument();
    const created = (await api.listAgents({})).data.find(
      (agent) => agent.name === "Hosted reviewer",
    );
    expect(created).toBeDefined();
    if (!created) throw new Error("Created agent was not listed");
    const detail = await api.getAgent(created.id);
    expect(detail.versions[0]?.config.sandbox).toEqual({
      enabled: true,
      provider: "daytona-primary",
      snapshotId: "77777777-7777-4777-8777-777777777777",
      network: "restricted",
      capabilities: ["filesystem_read", "filesystem_write", "shell"],
    });
    expect(detail.versions[0]?.config.skillVersionIds).toEqual([
      "44444444-4444-4444-8444-444444444445",
    ]);
  });

  it("creates an agent without a Daytona provider when sandboxing is disabled", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    vi.spyOn(api, "listSandboxProviders").mockResolvedValue({
      data: [],
      credentialEncryptionConfigured: true,
    });
    renderConsole("/agents", api);
    await user.click(
      await screen.findByRole("button", { name: "Create agent" }),
    );
    const dialog = within(screen.getByRole("dialog", { name: "Create agent" }));
    await user.type(dialog.getByLabelText("Name"), "Without sandbox");

    const createButton = dialog.getByRole("button", { name: "Create agent" });
    await waitFor(() => expect(createButton).toBeEnabled());
    await user.click(dialog.getByRole("checkbox", { name: "Enable sandbox" }));
    expect(createButton).toBeDisabled();
    await user.click(dialog.getByRole("checkbox", { name: "Enable sandbox" }));
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    expect(
      await screen.findByRole("heading", { name: "Without sandbox" }),
    ).toBeInTheDocument();
    const created = (await api.listAgents({})).data.find(
      (agent) => agent.name === "Without sandbox",
    );
    expect(created).toBeDefined();
    if (!created) throw new Error("Created agent was not listed");
    const detail = await api.getAgent(created.id);
    expect(detail.versions[0]?.config.sandbox).toEqual({
      enabled: false,
      provider: "not-configured",
      network: "none",
      capabilities: ["filesystem_read", "filesystem_write", "shell"],
    });
  });

  it("disables a Skill, hides it from the agent picker, and enables it again", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/skills/44444444-4444-4444-8444-444444444446", api);
    await screen.findByRole("heading", { name: "Carrier Codes" });
    await user.click(screen.getByRole("button", { name: "Disable Skill" }));
    const dialog = screen.getByRole("dialog", {
      name: "Disable “Carrier Codes”?",
    });
    expect(
      within(dialog).getByText(/enabling the Skill again restores it/u),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Disable Skill" }),
    );
    expect(
      await screen.findByRole("button", { name: "Enable Skill" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("disabled").length).toBeGreaterThan(0);
    const listed = await api.listSkills({});
    expect(
      listed.data.find((skill) => skill.key === "carrier-codes")?.disabledAt,
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Enable Skill" }));
    expect(
      await screen.findByRole("button", { name: "Disable Skill" }),
    ).toBeInTheDocument();
    expect(
      (await api.getSkill("44444444-4444-4444-8444-444444444446")).disabledAt,
    ).toBeNull();
  });

  it("disables, enables, and removes Skills from the list view", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/skills", api);
    expect(await screen.findByText("Carrier Codes")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Disable Skill Carrier Codes" }),
    );
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Disable “Carrier Codes”?" }),
      ).getByRole("button", { name: "Disable Skill" }),
    );
    expect(
      await screen.findByRole("button", { name: "Enable Skill Carrier Codes" }),
    ).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Enable Skill Carrier Codes" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Disable Skill Carrier Codes",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("disabled")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove Skill Carrier Codes" }),
    );
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Remove “Carrier Codes”?" }),
      ).getByRole("button", { name: "Remove Skill" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Carrier Codes")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Shipment Intake")).toBeInTheDocument();
  });

  it("removes a Skill from its detail page and returns to the list", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/skills/44444444-4444-4444-8444-444444444446", api);
    await screen.findByRole("heading", { name: "Carrier Codes" });
    await user.click(screen.getByRole("button", { name: "Remove Skill" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Remove “Carrier Codes”?" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Skill" }));
    const dialog = screen.getByRole("dialog", {
      name: "Remove “Carrier Codes”?",
    });
    expect(
      within(dialog).getByText(/the key becomes free for a new Skill/u),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Skill" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Skills" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Shipment Intake")).toBeInTheDocument();
    expect(screen.queryByText("Carrier Codes")).not.toBeInTheDocument();
    await expect(
      api.getSkill("44444444-4444-4444-8444-444444444446"),
    ).rejects.toThrow("Skill not found");
  });

  it("downloads a Skill version as a portable bundle", async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const clicks: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:skill-bundle";
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    try {
      renderConsole("/skills/44444444-4444-4444-8444-444444444444");
      await screen.findByRole("heading", { name: "Shipment Intake" });
      await user.click(screen.getAllByRole("button", { name: "Download" })[0]!);
      await waitFor(() => expect(clicks).toHaveLength(1));
      expect(clicks[0]).toMatch(/^shipment-intake-v\d+\.skill\.json$/u);
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () =>
          resolve(String(reader.result ?? "")),
        );
        reader.addEventListener("error", () => reject(reader.error));
        reader.readAsText(blobs[0]!);
      });
      const bundle = JSON.parse(text) as {
        kind: string;
        schemaVersion: number;
        skill: { displayName: string; instructions: string };
        files: readonly { path: string }[];
      };
      expect(bundle.kind).toBe("oao.skill");
      expect(bundle.schemaVersion).toBe(1);
      expect(bundle.skill.displayName).toBe("Shipment Intake");
      expect(bundle.skill.instructions.length).toBeGreaterThan(0);
      expect(Array.isArray(bundle.files)).toBe(true);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it("uploads a Skill bundle into a reviewable draft", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/skills", api);
    await screen.findByRole("heading", { name: "Skills" });
    const bundle = {
      schemaVersion: 1,
      kind: "oao.skill",
      skill: {
        key: "imported-intake",
        displayName: "Imported Intake",
        name: "imported-intake",
        description: "Imported from another project.",
        instructions: "# Imported\n\nFollow the imported steps.",
      },
      files: [
        {
          path: "references/checklist.md",
          contentType: "text/markdown",
          dataBase64: btoa("# Checklist\n\n- one"),
        },
      ],
    };
    await user.upload(
      screen.getByLabelText("Upload Skill file"),
      new File([JSON.stringify(bundle)], "imported-intake-v1.skill.json", {
        type: "application/json",
      }),
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Create Skill" }),
    );
    expect(dialog.getByDisplayValue("Imported Intake")).toBeInTheDocument();
    expect(
      dialog.getByDisplayValue("Imported from another project."),
    ).toBeInTheDocument();
    expect(
      dialog.getByRole("button", { name: "Files (1)" }),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.click(dialog.getByRole("button", { name: "Publish Skill" }));
    expect(
      await screen.findByRole("heading", { name: "Imported Intake" }),
    ).toBeInTheDocument();
    const created = (await api.listSkills({})).data.find(
      (skill) => skill.name === "imported-intake",
    );
    expect(created?.fileCount).toBe(1);
  });

  it("rejects a file that is not a Skill bundle", async () => {
    const user = userEvent.setup();
    renderConsole("/skills");
    await screen.findByRole("heading", { name: "Skills" });
    await user.upload(
      screen.getByLabelText("Upload Skill file"),
      new File(["{}"], "notes.json", { type: "application/json" }),
    );
    expect(
      await screen.findByText(/not an OAO Skill bundle/u),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Create Skill" }),
    ).not.toBeInTheDocument();
  });

  it("publishes a reusable Skill with nested Markdown resources", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/skills", api);
    expect(
      await screen.findByRole("heading", { name: "Skills" }),
    ).toBeInTheDocument();
    // The explainer is a collapsed disclosure below the list.
    const explainer = screen.getByRole("button", { name: "How Skills work" });
    expect(explainer).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText(/sessions inherit those bindings automatically/u),
    ).not.toBeVisible();
    await user.click(explainer);
    expect(
      screen.getByText(/sessions inherit those bindings automatically/u),
    ).toBeVisible();
    expect(screen.getByText(/\.flue\/packaged-skills\//u)).toBeVisible();
    await user.click(explainer);
    expect(await screen.findByText("Shipment Intake")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Skill" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Create Skill" }),
    );
    await user.type(dialog.getByLabelText("Display name"), "Business Rules");
    expect(dialog.getByLabelText("Skill name")).toHaveValue("business-rules");
    await user.type(
      dialog.getByLabelText("Description"),
      "Apply the approved customer operating rules.",
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.type(
      dialog.getByLabelText("Instructions"),
      "Load the relevant customer reference only when a rule applies.",
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.click(dialog.getByRole("button", { name: "New folder" }));
    await user.type(dialog.getByLabelText("Folder name"), "references{Enter}");
    await waitFor(() =>
      expect(dialog.getAllByText("references").length).toBeGreaterThan(0),
    );
    await user.click(dialog.getByRole("button", { name: "New file" }));
    await user.type(dialog.getByLabelText("File name"), "rules.md{Enter}");
    const rules = await dialog.findByLabelText("Markdown content");
    await user.clear(rules);
    await user.type(rules, "# Approved rules");
    await user.click(dialog.getByRole("button", { name: "Save file" }));
    await user.click(dialog.getByRole("button", { name: "Back to files" }));
    await user.click(dialog.getByRole("button", { name: "New file" }));
    await user.type(
      dialog.getByLabelText("File name"),
      "examples/checklist.md{Enter}",
    );
    expect(
      await dialog.findByText("references/examples/checklist.md"),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Back to files" }));
    await user.click(dialog.getByRole("button", { name: "Publish Skill" }));
    expect(
      await screen.findByRole("heading", { name: "Business Rules" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Version 1")).toBeInTheDocument();
    const created = (await api.listSkills({})).data.find(
      (skill) => skill.name === "business-rules",
    );
    expect(created?.versionIds).toHaveLength(1);
    expect(created?.fileCount).toBe(2);
    await user.click(screen.getByRole("button", { name: "Deprecate" }));
    expect(await screen.findByText("deprecated")).toBeInTheDocument();
  });

  it("guides MCP setup from server details through an agent binding", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/mcp", api);
    expect(
      await screen.findByRole("heading", { name: "MCP connections" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getAllByRole("button", { name: "Add MCP server" })[0]!,
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Add MCP server" }),
    );
    await user.type(
      dialog.getByLabelText("Display name"),
      "Trace observability",
    );
    expect(dialog.getByLabelText("Connection key")).toHaveValue(
      "trace-observability",
    );
    await user.type(
      dialog.getByLabelText("HTTPS MCP endpoint"),
      "https://mcp.example.test/rpc",
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.type(dialog.getByLabelText("Secret"), "fake-secret-value");
    await user.click(dialog.getByRole("button", { name: "Next" }));
    expect(
      dialog.getAllByText("https://mcp.example.test/rpc").length,
    ).toBeGreaterThan(0);
    await user.click(dialog.getByRole("button", { name: "Test and discover" }));
    await user.click(
      await dialog.findByRole("checkbox", { name: /Look up trace/u }),
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.selectOptions(
      dialog.getByLabelText("Attach to agent"),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(dialog.getByLabelText("Tool namespace")).toHaveValue(
      "trace_observability",
    );
    await user.click(dialog.getByRole("button", { name: "Finish setup" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("heading", { name: "Trace observability" }),
    ).toBeInTheDocument();
    const toolsets = await api.listMcpToolsets();
    expect(toolsets.data[0]?.tools.map((tool) => tool.remoteToolName)).toEqual([
      "lookup_trace",
    ]);
    const agent = await api.getAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(agent.versions[0]?.config.mcpBindings).toEqual([
      expect.objectContaining({ namespace: "trace_observability" }),
    ]);

    await user.click(
      screen.getByRole("button", { name: "Advanced resources" }),
    );
    await user.click(screen.getByRole("button", { name: "Create toolset" }));
    const toolsetDialog = within(
      await screen.findByRole("dialog", { name: "Create MCP toolset" }),
    );
    await user.type(toolsetDialog.getByLabelText("Key"), "trace-read-only");
    await user.type(
      toolsetDialog.getByLabelText("Display name"),
      "Trace read only",
    );
    await user.selectOptions(
      toolsetDialog.getByLabelText("Approval policy"),
      "never",
    );
    await user.click(
      toolsetDialog.getByRole("checkbox", { name: /Look up trace/u }),
    );
    await user.click(toolsetDialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const manualToolset = (await api.listMcpToolsets()).data.find(
      (toolset) => toolset.key === "trace-read-only",
    );
    expect(manualToolset?.tools).toEqual([
      expect.objectContaining({
        remoteToolName: "lookup_trace",
        approval: "never",
      }),
    ]);
  });

  it("uploads multiple Markdown files into the selected package folder", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/skills", api);
    await user.click(
      await screen.findByRole("button", { name: "Create Skill" }),
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Create Skill" }),
    );
    await user.type(dialog.getByLabelText("Display name"), "Upload check");
    expect(dialog.getByLabelText("Skill name")).toHaveValue("upload-check");
    await user.type(
      dialog.getByLabelText("Description"),
      "Checks uploaded reference files.",
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.type(
      dialog.getByLabelText("Instructions"),
      "Read the relevant uploaded reference.",
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.click(dialog.getByRole("button", { name: "New folder" }));
    await user.type(
      dialog.getByLabelText("Folder name"),
      "references/imported{Enter}",
    );
    await waitFor(() =>
      expect(dialog.getByText("imported")).toBeInTheDocument(),
    );
    const upload = dialog.getByLabelText("Upload Markdown");
    await user.upload(upload, [
      new File(["# Alpha"], "alpha.md", { type: "text/markdown" }),
      new File(["# Beta"], "beta.md", { type: "text/markdown" }),
    ]);
    expect(await dialog.findByText("alpha.md")).toBeInTheDocument();
    expect(await dialog.findByText("beta.md")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Publish Skill" }));
    expect(
      await screen.findByRole("heading", { name: "Upload check" }),
    ).toBeInTheDocument();
    const created = (await api.listSkills({})).data.find(
      (skill) => skill.name === "upload-check",
    );
    expect(created?.fileCount).toBe(2);
  });

  it("clones all existing resources when publishing a new Skill version", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    const original = await api.createSkill({
      displayName: "Versioned references",
      name: "versioned-references",
      description: "Keeps exact reference versions.",
      instructions: "Read the appropriate customer reference.",
      files: [
        {
          path: "references/customers/acme.md",
          contentType: "text/markdown",
          dataBase64: "IyBBY21lIHYx",
        },
        {
          path: "references/customers/globex.md",
          contentType: "text/markdown",
          dataBase64: "IyBHbG9iZXggdjE=",
        },
      ],
    });
    renderConsole(`/skills/${original.id}`, api);
    await user.click(
      await screen.findByRole("button", { name: "Publish new version" }),
    );
    const dialog = within(
      await screen.findByRole("dialog", {
        name: "Publish new Skill version",
      }),
    );
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.click(dialog.getByRole("button", { name: "Next" }));
    await user.click(dialog.getByRole("button", { name: "references" }));
    await user.click(dialog.getByRole("button", { name: "customers" }));
    expect(dialog.getByText("acme.md")).toBeInTheDocument();
    expect(dialog.getByText("globex.md")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Publish version" }));
    expect(await screen.findByText("Version 2")).toBeInTheDocument();
    const updated = await api.getSkill(original.id);
    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[0]?.files).toHaveLength(2);
    expect(updated.versions[1]?.files).toHaveLength(2);
  });

  it("renders complete Skill instructions and Markdown references", async () => {
    class MarkdownSkillApi extends DemoConsoleApi {
      override async getSkill(id: string) {
        const skill = await super.getSkill(id);
        const version = skill.versions[0];
        if (!version) return skill;
        return {
          ...skill,
          fileCount: 1,
          versions: [
            {
              ...version,
              instructions:
                "# Complete instructions\n\nFollow **every step** in this procedure.",
              files: [
                {
                  path: "references/checklist.md",
                  contentType: "text/markdown",
                  sizeBytes: 55,
                  sha256: "a".repeat(64),
                },
              ],
            },
          ],
        };
      }

      override async exportSkillVersion() {
        return {
          files: [
            {
              path: "references/checklist.md",
              contentType: "text/markdown",
              dataBase64:
                "IyBSZWZlcmVuY2UgY2hlY2tsaXN0CgotIFVzZSB0aGUgZXhhY3QgcmVmZXJlbmNlIGFuc3dlci4=",
            },
          ],
        };
      }
    }

    const user = userEvent.setup();
    renderConsole(
      "/skills/44444444-4444-4444-8444-444444444444",
      new MarkdownSkillApi({ eventDelayMs: 60_000 }),
    );
    expect(
      await screen.findByRole("heading", { name: "Shipment Intake" }),
    ).toBeInTheDocument();

    await user.click(screen.getByText("Instructions"));
    expect(
      await screen.findByRole("heading", { name: "Complete instructions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("every step").tagName).toBe("STRONG");

    await user.click(screen.getByText(/Reference resources/u));
    expect(
      await screen.findByRole("heading", { name: "Reference checklist" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Use the exact reference answer."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\.flue\/packaged-skills\/.*references\/checklist\.md/u),
    ).toBeInTheDocument();
  });

  it("keeps the default query cache stable across app rerenders", async () => {
    class CountingApi extends DemoConsoleApi {
      calls = 0;
      override async listAgents(
        filters: Parameters<DemoConsoleApi["listAgents"]>[0],
      ) {
        this.calls += 1;
        return super.listAgents(filters);
      }
    }
    const api = new CountingApi({ eventDelayMs: 60_000 });
    const view = render(
      <MemoryRouter initialEntries={["/agents"]}>
        <ConsoleApp api={api} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Support operator")).toBeInTheDocument();
    expect(api.calls).toBe(1);
    view.rerender(
      <MemoryRouter initialEntries={["/agents"]}>
        <ConsoleApp api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.calls).toBe(1));
  });

  it("renders deterministic empty and error states", async () => {
    const empty = renderConsole(
      "/agents",
      new DemoConsoleApi({ scenario: "empty", eventDelayMs: 60_000 }),
    );
    expect(
      await screen.findByRole("heading", { name: "No agents yet" }),
    ).toBeInTheDocument();
    empty.unmount();
    renderConsole(
      "/agents",
      new DemoConsoleApi({ scenario: "error", eventDelayMs: 60_000 }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "demo service is temporarily unavailable",
    );
  });

  it("reads as a conversation with inline tool activity", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    expect(
      await screen.findByRole("heading", {
        name: "Refund request · Northwind #4831",
      }),
    ).toBeInTheDocument();
    // The prompt and the answer are messages; the work behind them is not.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(
      screen.getByText(/expedited shipment was charged twice/u),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Support operator").length).toBeGreaterThan(0);
    // Tool calls show their useful transcript content without an inspector.
    const tool = screen.getByRole("button", { name: /^lookup_customer/u });
    expect(tool).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/customer_ref/u)).not.toBeInTheDocument();
    await user.click(tool);
    expect(tool).toHaveAttribute("aria-expanded", "true");
    // Arguments and the tool response render as highlighted JSON tokens.
    expect(screen.getByText('"customer_ref"')).toHaveClass("jt-key");
    expect(screen.getByText('"matches"')).toHaveClass("jt-key");
    expect(
      within(screen.getByLabelText("Response from lookup_customer")).getByText(
        "2",
      ),
    ).toHaveClass("jt-num");
    expect(screen.queryByRole("tab", { name: "Raw" })).not.toBeInTheDocument();
    // Tool events without arguments still open to their safe metadata.
    const skillTool = screen.getByRole("button", {
      name: /^skill\.activated/u,
    });
    expect(skillTool).toHaveAttribute("aria-expanded", "false");
    await user.click(skillTool);
    const skillDetail = skillTool.closest("article");
    expect(skillDetail).not.toBeNull();
    expect(
      within(skillDetail!).getByText("shipment-intake"),
    ).toBeInTheDocument();
    expect(within(skillDetail!).getByText("true")).toBeInTheDocument();
  });

  it("decodes a JSON-string tool response into readable structured data", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    const session = await api.getSession("session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...session,
      events: session.events.map((event) =>
        event.id === "event-tool-1" && event.payload
          ? {
              ...event,
              payload: {
                ...event.payload,
                rendered: {
                  ...event.payload.rendered,
                  result: {
                    result: JSON.stringify({
                      attachment_tms_overrides: {},
                      created_at: "2026-08-25T20:19:43.741Z",
                      customer: null,
                    }),
                  },
                },
              },
            }
          : event,
      ),
    });

    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V", api);
    const tool = await screen.findByRole("button", {
      name: /^lookup_customer/u,
    });
    await user.click(tool);
    const response = screen.getByLabelText("Response from lookup_customer");
    expect(
      within(response).getByText('"attachment_tms_overrides"'),
    ).toHaveClass("jt-key");
    expect(within(response).queryByText('"result"')).not.toBeInTheDocument();
    expect(response.textContent).not.toContain(
      '\\"attachment_tms_overrides\\"',
    );
  });

  it("shows reasoning and sandbox contents directly in the transcript", async () => {
    const user = userEvent.setup();
    class SandboxActivityApi extends DemoConsoleApi {
      override async getSession(id: string) {
        const session = await super.getSession(id);
        return {
          ...session,
          workspaceFiles: [
            {
              name: "input.xlsx",
              path: ".oao/attachments/run/input.xlsx",
              sizeBytes: 12,
              uploaded: true,
              backedUp: true,
              backedUpAt: "2026-08-20T19:21:49.000Z",
              storageProviderId: "88888888-8888-4888-8888-000000000001",
              objectKey: "run-files/runs/run/file-1/input.xlsx",
            },
            {
              name: "test.csv",
              path: "/root/test.csv",
              backedUp: true,
              backedUpAt: "2026-08-20T19:21:49.000Z",
            },
          ],
          events: [
            ...session.events,
            {
              id: "debug:modelInvocations:reasoning-1",
              kind: "reasoning" as const,
              source: "activity" as const,
              title: "Reasoning",
              summary: "Checking the workbook rows before writing the result.",
              createdAt: "2026-08-20T19:21:47.000Z",
              durationMs: 5_680,
              status: "success" as const,
              tokens: { input: 832, output: 231 },
            },
            {
              id: "debug:sandboxCommands:write-1",
              kind: "tool" as const,
              source: "activity" as const,
              title: "write",
              summary: "/root/test.csv",
              createdAt: "2026-08-20T19:21:48.150Z",
              durationMs: 152,
              status: "success" as const,
              payload: {
                rendered: {
                  arguments: {
                    path: "/root/test.csv",
                    content: "id,name\n1,Alice",
                  },
                  result: {
                    content: [{ type: "text", text: "Wrote 18 bytes" }],
                  },
                },
                raw: JSON.stringify({
                  arguments: {
                    path: "/root/test.csv",
                    content: "id,name\n1,Alice",
                  },
                  result: "Wrote 18 bytes",
                }),
                redacted: false,
              },
            },
          ],
        };
      }
    }

    renderConsole(
      "/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V",
      new SandboxActivityApi({ eventDelayMs: 60_000 }),
    );
    const reasoning = await screen.findByRole("button", {
      name: /^Reasoning/u,
    });
    const tool = screen.getByRole("button", { name: /^write/u });
    const row = tool.closest(".activity");
    expect(row).not.toBeNull();
    expect(reasoning).toHaveAttribute("aria-expanded", "false");
    expect(tool).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText(
        "Checking the workbook rows before writing the result.",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByText(/id,name/u),
    ).not.toBeInTheDocument();
    await user.click(reasoning);
    expect(reasoning).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Checking the workbook rows before writing the result."),
    ).toBeInTheDocument();
    expect(screen.getByText("5,680 ms")).toBeInTheDocument();
    expect(screen.getByText("832 in / 231 out")).toBeInTheDocument();
    await user.click(tool);
    expect(tool).toHaveAttribute("aria-expanded", "true");
    expect(
      within(row as HTMLElement).queryByText("Payload"),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).getAllByText(/root\/test.csv/u).length,
    ).toBeGreaterThan(0);
    expect(
      within(row as HTMLElement).getByText(/id,name/u),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText(/Wrote 18 bytes/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Jump to Reasoning/u }).className,
    ).toContain("minimap-seg--reasoning");
    expect(
      screen.getAllByRole("button", { name: /^Jump to Tool/u }).at(-1)
        ?.className,
    ).toContain("minimap-seg--tool");
    const panel = screen.getByRole("complementary", {
      name: "Session details",
    });
    const uploadedFile = within(panel).getByRole("link", {
      name: "input.xlsx",
    });
    expect(uploadedFile).toHaveAttribute(
      "href",
      "/storage-providers/88888888-8888-4888-8888-000000000001?prefix=run-files%2Fruns%2Frun%2Ffile-1%2F&highlight=input.xlsx",
    );
    expect(uploadedFile).toHaveAttribute(
      "title",
      "input.xlsx — open in storage provider",
    );
    expect(within(panel).getByText("Uploaded + backed up")).toBeInTheDocument();
    const sandboxFile = within(panel).getByText("test.csv");
    expect(sandboxFile).toHaveAttribute("title", "test.csv");
    expect(sandboxFile.closest("a")).toBeNull();
    expect(within(panel).getByText("Backed up")).toBeInTheDocument();
  });

  it("renders message Markdown without executing raw HTML", async () => {
    class MarkdownApi extends DemoConsoleApi {
      override async getSession(id: string) {
        const session = await super.getSession(id);
        return {
          ...session,
          events: session.events.map((event) =>
            event.id === "event-model-1"
              ? {
                  ...event,
                  summary: [
                    "Here is what I found:",
                    "",
                    "- **Reading files** with `src/index.ts`",
                    "- [Documentation](https://example.com)",
                    "",
                    "| File | Status |",
                    "| --- | --- |",
                    "| README.md | Ready |",
                    "",
                    '<script>alert("unsafe")</script>',
                    "[Unsafe link](javascript:alert(1))",
                  ].join("\n"),
                }
              : event,
          ),
        };
      }
    }

    renderConsole(
      "/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V",
      new MarkdownApi({ eventDelayMs: 60_000 }),
    );
    expect(await screen.findByText("Reading files")).toHaveProperty(
      "tagName",
      "STRONG",
    );
    expect(screen.getByText("src/index.ts")).toHaveProperty("tagName", "CODE");
    expect(screen.getByRole("link", { name: "Documentation" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(
      screen.getByRole("columnheader", { name: "File" }),
    ).toBeInTheDocument();
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText("Unsafe link").closest("a")).toHaveAttribute(
      "href",
      "",
    );
  });

  it("keeps platform telemetry out of the transcript but in the debug tab", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    // The tool call reads as transcript activity; the sidebar also names the
    // tool, so this asserts on the conversation row specifically.
    expect(
      await screen.findByRole("button", { name: /^lookup_customer/u }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /dispatch admitted/u }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("run.created")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Debug" }));
    expect(
      screen.getByRole("button", {
        name: /^Inspect runtime\.dispatch admitted/u,
      }),
    ).toBeInTheDocument();
  });

  it("explains exact provider finish errors in the event inspector", async () => {
    const user = userEvent.setup();
    const explanation =
      "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.";
    class FailedInvocationApi extends DemoConsoleApi {
      override async getSession(id: string) {
        const session = await super.getSession(id);
        return {
          ...session,
          status: "failed" as const,
          events: [
            {
              id: "debug:modelInvocations:filtered-1",
              kind: "error" as const,
              source: "activity" as const,
              title: "model.invocation failed",
              summary: explanation,
              createdAt: "2026-08-20T19:21:47.000Z",
              durationMs: 15_321,
              status: "error" as const,
              tokens: { input: 0, output: 0 },
              payload: {
                rendered: {
                  model: "@preset/global-medium",
                  attempt: 1,
                  finishReason: "error",
                  providerFinishReason: "content_filter",
                  errorExplanation: explanation,
                },
                raw: null,
                redacted: true,
                redactionReason:
                  "Only public, redacted metadata is available in this view.",
              },
            },
          ],
        };
      }
    }

    renderConsole(
      "/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V?tab=debug",
      new FailedInvocationApi({ eventDelayMs: 60_000 }),
    );
    const inspector = await screen.findByRole("complementary", {
      name: "Event inspector",
    });
    expect(within(inspector).getByText("Finish reason")).toBeInTheDocument();
    expect(
      within(inspector).getByText("Provider finish reason"),
    ).toBeInTheDocument();
    expect(within(inspector).getByText("content_filter")).toBeInTheDocument();
    expect(
      within(inspector).getByText("Why this is an error"),
    ).toBeInTheDocument();
    expect(within(inspector).getAllByText(explanation)).toHaveLength(2);
    await user.click(
      within(inspector).getByRole("tab", {
        name: "Raw",
      }),
    );
    await user.click(
      within(inspector).getByRole("button", {
        name: "Reveal redaction detail",
      }),
    );
    expect(
      within(inspector).getByText(
        "Only public, redacted metadata is available in this view.",
      ),
    ).toBeInTheDocument();
  });

  it("charts the thread as states with striped idle and a hover card", async () => {
    const user = userEvent.setup();
    const scrolledTo: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolledTo.push(this.id);
    });
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    const minimap = await screen.findByRole("group", {
      name: "Session timeline",
    });
    const elapsed = screen.getByRole("group", {
      name: /^Elapsed timeline from 0 seconds to/u,
    });
    expect(elapsed).toHaveTextContent("0s");
    expect(within(elapsed).getAllByText(/s$/u)).toHaveLength(5);
    // The strip is contiguous states: user, agent, skill activation, two
    // parallel Harness calls, tool, error, retry, approval, plus idle segments.
    expect(within(minimap).getAllByRole("button")).toHaveLength(9);
    const parallelStack = within(minimap).getByRole("group", {
      name: "2 parallel Harness Operations",
    });
    expect(parallelStack).toHaveClass(
      "minimap-stack",
      "minimap-stack--parallel",
    );
    const parallelSegments = within(parallelStack).getAllByRole("button");
    expect(parallelSegments).toHaveLength(2);
    const extractSegment = within(parallelStack).getByRole("button", {
      name: /Harness · extract_shipment/u,
    });
    const verifySegment = within(parallelStack).getByRole("button", {
      name: /Harness · verify_shipment/u,
    });
    expect(extractSegment).toHaveStyle({ width: "100%" });
    expect(Number.parseFloat(verifySegment.style.width)).toBeLessThan(100);
    expect(
      within(minimap).getAllByRole("img", { name: /^Idle for/u }).length,
    ).toBeGreaterThan(0);
    const errorSeg = within(minimap).getByRole("button", {
      name: /^Jump to Error/u,
    });
    expect(errorSeg.className).toContain("minimap-seg--error");
    // Hovering names the state, its text, and how long it lasted.
    const userSeg = within(minimap).getByRole("button", {
      name: /^Jump to User/u,
    });
    await user.hover(userSeg);
    expect(document.querySelector(".minimap-tip")?.textContent).toContain(
      "Customer Northwind #4831",
    );
    await user.hover(errorSeg);
    expect(document.querySelector(".minimap-tip")?.textContent).toContain(
      "10.0s",
    );
    await user.click(userSeg);
    expect(scrolledTo).toContain("event-event-user-1");
    expect(document.getElementById("event-event-user-1")?.className).toContain(
      "is-flashed",
    );
    vi.restoreAllMocks();
  });

  it("highlights the hovered message's block on the timeline", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    const minimap = await screen.findByRole("group", {
      name: "Session timeline",
    });
    const userSeg = within(minimap).getByRole("button", {
      name: /^Jump to User/u,
    });
    expect(userSeg.className).not.toContain("minimap-seg--hot");
    await user.hover(
      screen.getByText(/Customer Northwind #4831 says the expedited/u),
    );
    expect(userSeg.className).toContain("minimap-seg--hot");
    // The timeline tooltip names the hovered block as if it were hovered directly.
    expect(document.querySelector(".minimap-tip")?.textContent).toContain(
      "Customer Northwind #4831",
    );
    await user.unhover(
      screen.getByText(/Customer Northwind #4831 says the expedited/u),
    );
    expect(userSeg.className).not.toContain("minimap-seg--hot");
    expect(document.querySelector(".minimap-tip")).toBeNull();
  });

  it("shows the session panel with details, cost chart, and usage", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    const panel = await screen.findByRole("complementary", {
      name: "Session details",
    });
    expect(
      within(panel).getByText("session_01J5QTXE7W9M2R6C4A8K3N1P0V"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "Support operator" }),
    ).toBeInTheDocument();
    expect(within(panel).getByText("$0.0184")).toBeInTheDocument();
    expect(within(panel).getByText("2,841")).toBeInTheDocument();
    expect(within(panel).getByText("Cache read tokens")).toBeInTheDocument();
    expect(within(panel).getByText("1,536")).toBeInTheDocument();
    expect(within(panel).getByText("Cache write tokens")).toBeInTheDocument();
    expect(within(panel).getByText("704")).toBeInTheDocument();
    expect(screen.getByText("2 Skills")).toHaveAttribute(
      "title",
      "shipment-intake v1, carrier-codes v1",
    );
    // Bound Skills are listed with the activated ones highlighted.
    const skillsSection = within(panel).getByRole("region", { name: "Skills" });
    expect(within(skillsSection).getByText("1 of 2 used")).toBeInTheDocument();
    const usedRow = within(skillsSection)
      .getByRole("link", { name: "shipment-intake" })
      .closest("li");
    expect(usedRow?.className).toContain("usage--used");
    expect(
      within(usedRow as HTMLElement).getByText("Used"),
    ).toBeInTheDocument();
    const unusedRow = within(skillsSection)
      .getByRole("link", { name: "carrier-codes" })
      .closest("li");
    expect(unusedRow?.className).not.toContain("usage--used");
    expect(
      within(unusedRow as HTMLElement).getByText("Not used"),
    ).toBeInTheDocument();
    // The agent version's tools are listed the same way, with call counts.
    const toolsSection = within(panel).getByRole("region", { name: "Tools" });
    expect(within(toolsSection).getByText("1 of 2 used")).toBeInTheDocument();
    const calledTool = within(toolsSection)
      .getByText("lookup_customer")
      .closest("li");
    expect(calledTool?.className).toContain("usage--used");
    expect(
      within(calledTool as HTMLElement).getByText("1×"),
    ).toBeInTheDocument();
    const uncalledTool = within(toolsSection)
      .getByText("issue_refund")
      .closest("li");
    expect(uncalledTool?.className).not.toContain("usage--used");
    expect(
      within(uncalledTool as HTMLElement).getByText("Not used"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("img", {
        name: /Cumulative cost over the session/u,
      }),
    ).toBeInTheDocument();
    // The panel closes to give the conversation the full width, and reopens.
    await user.click(
      within(panel).getByRole("button", { name: "Close session details" }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Session details" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show session details" }),
    );
    expect(
      screen.getByRole("complementary", { name: "Session details" }),
    ).toBeInTheDocument();
  });

  it("copies and downloads the whole thread as Markdown", async () => {
    const user = userEvent.setup();
    const clicked: HTMLAnchorElement[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const node = createElement(tag, options);
      if (tag === "a") {
        vi.spyOn(node as HTMLAnchorElement, "click").mockImplementation(() => {
          clicked.push(node as HTMLAnchorElement);
        });
      }
      return node;
    });
    globalThis.URL.createObjectURL = vi.fn(() => "blob:thread");
    globalThis.URL.revokeObjectURL = vi.fn();

    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    await user.click(
      await screen.findByRole("button", { name: "Copy thread as Markdown" }),
    );
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("# Refund request · Northwind #4831");
    expect(copied).toContain("expedited shipment was charged twice");
    expect(copied).toContain("**lookup_customer**");
    // Telemetry stays out of the export, exactly as it stays off the screen.
    expect(copied).not.toContain("dispatch admitted");

    await user.click(
      screen.getByRole("button", { name: "Download thread as Markdown" }),
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe(
      "session-session_01J5QTXE7W9M2R6C4A8K3N1P0V.md",
    );
    vi.restoreAllMocks();
  });

  it("shows the debug waterfall, the inspector, and event filters", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    await user.click(await screen.findByRole("tab", { name: "Debug" }));
    await user.click(
      screen.getByRole("button", { name: "Inspect Provider request failed" }),
    );
    expect(
      screen.getByRole("heading", { name: "Provider request failed" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("10,004 ms").length).toBeGreaterThan(0);
    await user.type(
      screen.getByRole("searchbox", { name: "Filter events" }),
      "does-not-exist",
    );
    expect(
      screen.getByRole("heading", { name: "No matching events" }),
    ).toBeInTheDocument();
  });

  it("creates a session with its first durable user message", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions");
    await user.click(
      await screen.findByRole("button", { name: "Create session" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Agent"),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    await user.type(screen.getByLabelText("Title"), "Local browser slice");
    await user.type(
      screen.getByLabelText("First message"),
      "Complete the deterministic local task.",
    );
    await user.upload(
      screen.getByLabelText("Files"),
      new File(
        ["From: customer@example.com\r\nSubject: Renewal\r\n\r\nSafe context"],
        "renewal.eml",
      ),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Create session" }).at(-1)!,
    );
    expect(
      await screen.findByRole("heading", { name: "Local browser slice" }),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText("Complete the deterministic local task."),
    ).not.toHaveLength(0);
    expect(await screen.findByText("renewal.eml")).toBeInTheDocument();
    expect(screen.getByText(/message\/rfc822/u)).toBeInTheDocument();
  });

  it("groups a delegated child session directly beneath its coordinator", async () => {
    class DelegatedSessionsApi extends DemoConsoleApi {
      override async listSessions(
        filters: Parameters<DemoConsoleApi["listSessions"]>[0],
      ) {
        const page = await super.listSessions(filters);
        const parent = page.data.find(
          (session) => session.title === "Refund request · Northwind #4831",
        );
        const child = page.data.find(
          (session) => session.title === "Q3 contract extraction",
        );
        if (!parent || !child) return page;
        const rest = page.data.filter(
          (session) => session.id !== parent.id && session.id !== child.id,
        );
        return {
          ...page,
          // Deliberately return the child first to prove the UI builds the tree.
          data: [
            {
              ...child,
              title: "Delegated: shipment extraction",
              parentSessionId: parent.id,
              delegateKey: "shipment-extraction",
            },
            parent,
            ...rest,
          ],
        };
      }
    }

    renderConsole(
      "/sessions",
      new DelegatedSessionsApi({ eventDelayMs: 60_000 }),
    );
    const parentLink = await screen.findByRole("link", {
      name: /Refund request · Northwind #4831/u,
    });
    const childLink = screen.getByRole("link", {
      name: "Delegated: shipment extraction, delegated child session as shipment-extraction",
    });
    const parentRow = parentLink.closest("tr");
    const childRow = childLink.closest("tr");
    expect(parentRow).not.toBeNull();
    expect(childRow).not.toBeNull();
    if (!parentRow || !childRow)
      throw new Error("Session rows were not rendered");
    const rows = within(
      screen.getByRole("region", { name: "Sessions table" }),
    ).getAllByRole("row");
    expect(rows.indexOf(childRow)).toBe(rows.indexOf(parentRow) + 1);
    expect(childRow).toHaveClass("session-row--child");
    expect(childRow).toHaveAttribute(
      "data-parent-session-id",
      "session_01J5QTXE7W9M2R6C4A8K3N1P0V",
    );
    expect(within(childRow).getByText("└─")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(parentLink).toHaveAttribute(
      "href",
      "/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V",
    );
    expect(childLink).toHaveAttribute(
      "href",
      "/sessions/session_01J5PDRS7WZTP4H3F6M2A9B8CX",
    );
  });

  it("submits a second message with Command+Enter after the latest run settles", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5PDRS7WZTP4H3F6M2A9B8CX");
    const message = await screen.findByLabelText("Message");
    await user.type(message, "Now summarize only the renewal exceptions.");
    await user.upload(
      screen.getByLabelText("Attach files"),
      new File(['{"priority":"high"}'], "renewal.json", {
        type: "application/json",
      }),
    );
    // The attachment is listed with a size and can be removed before sending.
    expect(
      screen.getByRole("button", { name: "Remove renewal.json" }),
    ).toBeInTheDocument();
    expect(screen.getByText("19 B")).toBeInTheDocument();
    await user.click(message);
    await user.keyboard("{Enter}");
    expect(message).toHaveValue("Now summarize only the renewal exceptions.\n");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(
      await screen.findByText("Now summarize only the renewal exceptions."),
    ).toBeInTheDocument();
    expect(await screen.findByText("renewal.json")).toBeInTheDocument();
    // The composer's own attachment list is cleared once the message sends.
    expect(
      screen.queryByRole("button", { name: "Remove renewal.json" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });

  it("minimizes the composer on narrow viewports and reopens it on demand", async () => {
    const user = userEvent.setup();
    const originalMatchMedia = window.matchMedia;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 1024px), (max-height: 820px)",
        media: query,
        addEventListener: (
          _type: string,
          listener: (event: { matches: boolean }) => void,
        ) => listeners.add(listener),
        removeEventListener: (
          _type: string,
          listener: (event: { matches: boolean }) => void,
        ) => listeners.delete(listener),
      }),
    });
    try {
      renderConsole("/sessions/session_01J5PDRS7WZTP4H3F6M2A9B8CX");
      const open = await screen.findByRole("button", {
        name: "Send a message to the agent",
      });
      expect(open).toHaveAttribute("aria-expanded", "false");
      // The form stays mounted so a draft survives minimizing, but is hidden.
      expect(screen.getByLabelText("Message")).not.toBeVisible();
      await user.click(open);
      expect(screen.getByLabelText("Message")).toBeVisible();
      await user.type(screen.getByLabelText("Message"), "Keep this draft");
      await user.click(
        screen.getByRole("button", { name: "Minimize composer" }),
      );
      expect(screen.getByLabelText("Message")).not.toBeVisible();
      expect(screen.getByLabelText("Message")).toHaveValue("Keep this draft");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("claims caller work and resolves approvals", async () => {
    const user = userEvent.setup();
    renderConsole("/pending-work");
    expect(
      await screen.findByRole("heading", { name: "Pending Work" }),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Claim request" }),
    );
    expect(
      await screen.findByRole("button", { name: "Submit result" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit result" }));
    const resultValue = screen.getByLabelText("Successful result value");
    await user.clear(resultValue);
    await user.click(resultValue);
    await user.paste('{"found":true}');
    await user.click(
      screen.getByRole("button", { name: "Submit immutable result" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Submit immutable result" }),
      ).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Refund USD 84.50 to the original payment method"),
      ).not.toBeInTheDocument(),
    );
  });

  it("lists only provider-backed project model presets", async () => {
    renderConsole("/models");
    expect(
      await screen.findByRole("heading", { name: "Models" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Claude Sonnet 4.6 (zero retention)"),
    ).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.queryByText("Local deterministic")).not.toBeInTheDocument();
    expect(screen.getByText(/zero data retention/u)).toBeInTheDocument();
    // Provider secrets are write-only and never rendered.
    expect(document.body.textContent).not.toMatch(/OPENROUTER_API_KEY|apiKey/u);
  });

  it("opens a model preset, duplicates it into a prefilled new preset, and archives it", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/models", api);
    await user.click(
      await screen.findByRole("button", {
        name: /Claude Sonnet 4\.6 \(zero retention\)/u,
      }),
    );
    const detail = within(
      screen.getByRole("dialog", {
        name: "Claude Sonnet 4.6 (zero retention)",
      }),
    );
    expect(detail.getByText("claude-sonnet-4-6-zdr-v1")).toBeInTheDocument();
    expect(
      detail.getByText("OpenRouter primary · openrouter"),
    ).toBeInTheDocument();
    // Usage comes from the agents that pin the key.
    expect(
      detail.getByRole("link", { name: "Support operator" }),
    ).toBeInTheDocument();

    await user.click(
      detail.getByRole("button", { name: "Duplicate as new preset" }),
    );
    const duplicate = within(
      await screen.findByRole("dialog", {
        name: "Duplicate “Claude Sonnet 4.6 (zero retention)”",
      }),
    );
    expect(
      duplicate.getByDisplayValue("Claude Sonnet 4.6 (zero retention)"),
    ).toBeInTheDocument();
    expect(
      duplicate.getByDisplayValue("claude-sonnet-4-6-zero-retention-v1"),
    ).toBeInTheDocument();
    // The catalog answers the prefilled search and the source model is pinned.
    await waitFor(() =>
      expect(
        duplicate.getByRole("button", { name: "Add model preset" }),
      ).toBeEnabled(),
    );
    await user.click(
      duplicate.getByRole("button", { name: "Add model preset" }),
    );
    expect(
      await screen.findByText("claude-sonnet-4-6-zero-retention-v1"),
    ).toBeInTheDocument();
    const created = (await api.listModelPresets()).data.find(
      (preset) => preset.key === "claude-sonnet-4-6-zero-retention-v1",
    );
    expect(created?.routing).toEqual({
      zeroDataRetention: true,
      dataCollection: "deny",
      allowFallbacks: false,
      providerAllowlist: ["anthropic"],
    });

    await user.click(
      screen.getByRole("button", { name: /claude-sonnet-4-6-zdr-v1/u }),
    );
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    const confirm = within(
      screen.getByRole("dialog", {
        name: "Archive “Claude Sonnet 4.6 (zero retention)”?",
      }),
    );
    expect(confirm.getByText(/3 agents currently pin/u)).toBeInTheDocument();
    await user.click(confirm.getByRole("button", { name: "Archive preset" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /claude-sonnet-4-6-zdr-v1/u }),
      ).not.toBeInTheDocument(),
    );
    expect(
      (await api.listModelPresets()).data.map((preset) => preset.key),
    ).toEqual(["claude-sonnet-4-6-zero-retention-v1"]);
  });

  it("refuses to remove a provider connection while presets use it, then removes it", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/models", api);
    await screen.findByText("OpenRouter primary");
    const providerRow = screen.getByText("OpenRouter primary").closest("tr")!;
    await user.click(
      within(providerRow).getByRole("button", { name: "Remove" }),
    );
    let confirm = within(
      screen.getByRole("dialog", { name: "Remove “OpenRouter primary”?" }),
    );
    await user.click(
      confirm.getByRole("button", { name: "Remove connection" }),
    );
    expect(
      await confirm.findByText(
        /1 model preset still routes through this connection/u,
      ),
    ).toBeInTheDocument();
    await user.click(confirm.getByRole("button", { name: "Cancel" }));

    await api.archiveModelPreset("44444444-4444-4444-8444-444444444444");
    await user.click(
      within(providerRow).getByRole("button", { name: "Remove" }),
    );
    confirm = within(
      screen.getByRole("dialog", { name: "Remove “OpenRouter primary”?" }),
    );
    await user.click(
      confirm.getByRole("button", { name: "Remove connection" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("OpenRouter primary")).not.toBeInTheDocument(),
    );
    expect(
      (await api.listModelProviders()).map((provider) => provider.key),
    ).toEqual(["anthropic-primary", "xai-primary"]);
  });

  it("adds and rotates a project-scoped OpenAI provider without rendering its key", async () => {
    class CatalogTrackingApi extends DemoConsoleApi {
      openAICatalogLoads = 0;
      lastPresetInput:
        Parameters<DemoConsoleApi["createModelPreset"]>[0] | undefined;
      override async listModelCatalog(providerId: string, search?: string) {
        const result = await super.listModelCatalog(providerId, search);
        if (result.providerType === "openai") this.openAICatalogLoads += 1;
        return result;
      }
      override async createModelPreset(
        input: Parameters<DemoConsoleApi["createModelPreset"]>[0],
      ) {
        this.lastPresetInput = input;
        return super.createModelPreset(input);
      }
    }
    const user = userEvent.setup();
    const api = new CatalogTrackingApi({ eventDelayMs: 60_000 });
    renderConsole("/models", api);
    await user.click(
      await screen.findByRole("button", { name: "Add provider" }),
    );
    const create = within(
      screen.getByRole("dialog", { name: "Add model provider" }),
    );
    expect(
      create.getByRole("option", { name: "xAI (Grok)" }),
    ).toBeInTheDocument();
    await user.selectOptions(create.getByLabelText("Provider type"), "openai");
    await user.type(
      create.getByLabelText(/^Connection key/u),
      "openai-primary",
    );
    await user.type(create.getByLabelText("Display name"), "OpenAI primary");
    await user.type(
      create.getByLabelText(/^API key/u),
      "sk-openai-secret-value",
    );
    await user.click(create.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText("OpenAI primary")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-openai-secret-value");

    await user.click(screen.getByRole("button", { name: "Add model preset" }));
    const preset = within(
      screen.getByRole("dialog", { name: "Add model preset" }),
    );
    const openAIOption = preset.getByRole("option", {
      name: "OpenAI primary — openai",
    }) as HTMLOptionElement;
    await user.selectOptions(
      preset.getByLabelText("Provider connection"),
      openAIOption.value,
    );
    await waitFor(() => expect(api.openAICatalogLoads).toBeGreaterThan(0));
    const model = preset.getByRole("combobox", { name: /^Model/u });
    await user.click(model);
    await user.type(model, "gpt");
    await user.click(
      await preset.findByRole("option", { name: /GPT-5\.6 Terra/u }),
    );
    expect(preset.getByText(/^openai\/gpt-5\.6-terra/u)).toBeInTheDocument();
    expect(preset.getByLabelText("Text format")).toHaveValue("text");
    expect(preset.getByLabelText("Reasoning mode")).toHaveValue("standard");
    expect(preset.getByLabelText("Reasoning effort")).toHaveValue("medium");
    expect(preset.getByLabelText("Verbosity")).toHaveValue("medium");
    expect(preset.getByLabelText("Summary")).toHaveValue("auto");
    await user.selectOptions(preset.getByLabelText("Reasoning mode"), "pro");
    await user.selectOptions(preset.getByLabelText("Reasoning effort"), "high");
    await user.selectOptions(preset.getByLabelText("Verbosity"), "low");
    await user.selectOptions(preset.getByLabelText("Summary"), "detailed");
    expect(
      preset.getByText(
        /Direct provider presets use their selected connection/u,
      ),
    ).toBeInTheDocument();
    expect(
      preset.queryByText("Routing and data policy"),
    ).not.toBeInTheDocument();
    await user.click(preset.getByRole("button", { name: "Add model preset" }));
    await waitFor(() =>
      expect(api.lastPresetInput?.settings).toEqual({
        textFormat: "text",
        mode: "pro",
        effort: "high",
        verbosity: "low",
        summary: "detailed",
      }),
    );
    expect(
      await screen.findByText(
        /pro · high reasoning · low verbosity · detailed summary · text/u,
      ),
    ).toBeInTheDocument();

    const row = screen.getByText("OpenAI primary").closest("tr");
    expect(row).not.toBeNull();
    if (!row) throw new Error("Provider row was not rendered");
    await user.click(within(row).getByRole("button", { name: "Rotate key" }));
    const rotate = within(
      screen.getByRole("dialog", { name: "Rotate OpenAI primary key" }),
    );
    await user.type(
      rotate.getByLabelText(/^New API key/u),
      "sk-openai-rotated-value",
    );
    await user.click(rotate.getByRole("button", { name: "Rotate key" }));
    expect(await screen.findByText(/v2/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-openai-rotated-value");
  });

  it("adds an Anthropic provider and saves capability-aware Claude settings", async () => {
    class AnthropicTrackingApi extends DemoConsoleApi {
      anthropicCatalogLoads = 0;
      lastPresetInput:
        Parameters<DemoConsoleApi["createModelPreset"]>[0] | undefined;
      override async listModelCatalog(providerId: string, search?: string) {
        const result = await super.listModelCatalog(providerId, search);
        if (result.providerType === "anthropic")
          this.anthropicCatalogLoads += 1;
        return result;
      }
      override async createModelPreset(
        input: Parameters<DemoConsoleApi["createModelPreset"]>[0],
      ) {
        this.lastPresetInput = input;
        return super.createModelPreset(input);
      }
    }
    const user = userEvent.setup();
    const api = new AnthropicTrackingApi({ eventDelayMs: 60_000 });
    renderConsole("/models", api);
    await user.click(
      await screen.findByRole("button", { name: "Add provider" }),
    );
    const create = within(
      screen.getByRole("dialog", { name: "Add model provider" }),
    );
    await user.selectOptions(
      create.getByLabelText("Provider type"),
      "anthropic",
    );
    await user.type(
      create.getByLabelText(/^Connection key/u),
      "anthropic-testing",
    );
    await user.type(create.getByLabelText("Display name"), "Anthropic testing");
    await user.type(create.getByLabelText(/^API key/u), "sk-ant-secret-value");
    await user.click(create.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText("Anthropic testing")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-ant-secret-value");

    await user.click(screen.getByRole("button", { name: "Add model preset" }));
    const preset = within(
      screen.getByRole("dialog", { name: "Add model preset" }),
    );
    const providerOption = preset.getByRole("option", {
      name: "Anthropic testing — anthropic",
    }) as HTMLOptionElement;
    await user.selectOptions(
      preset.getByLabelText("Provider connection"),
      providerOption.value,
    );
    await waitFor(() => expect(api.anthropicCatalogLoads).toBeGreaterThan(0));
    const model = preset.getByRole("combobox", { name: /^Model/u });
    await user.click(model);
    await user.type(model, "sonnet");
    await user.click(
      await preset.findByRole("option", { name: /Claude Sonnet 5/u }),
    );
    expect(
      preset.getByText(/^anthropic\/claude-sonnet-5/u),
    ).toBeInTheDocument();
    expect(preset.getByLabelText("Thinking")).toHaveValue("adaptive");
    expect(preset.getByLabelText("Max tokens")).toHaveValue(20_000);
    expect(preset.getByLabelText("Effort")).toHaveValue("high");
    await user.selectOptions(preset.getByLabelText("Effort"), "xhigh");
    await user.clear(preset.getByLabelText("Max tokens"));
    await user.type(preset.getByLabelText("Max tokens"), "128001");
    expect(
      await preset.findByText(/cannot exceed 128,000/u),
    ).toBeInTheDocument();
    await user.clear(preset.getByLabelText("Max tokens"));
    await user.type(preset.getByLabelText("Max tokens"), "64000");
    await user.click(preset.getByRole("button", { name: "Add model preset" }));
    await waitFor(() =>
      expect(api.lastPresetInput?.settings).toEqual({
        thinking: "adaptive",
        maxTokens: 64_000,
        effort: "xhigh",
      }),
    );
    expect(
      await screen.findByText(
        /adaptive thinking · xhigh effort · 64,000 max tokens/u,
      ),
    ).toBeInTheDocument();
  });

  it("saves Grok reasoning settings and shows them in the model overview", async () => {
    class XAITrackingApi extends DemoConsoleApi {
      lastPresetInput:
        Parameters<DemoConsoleApi["createModelPreset"]>[0] | undefined;
      override async createModelPreset(
        input: Parameters<DemoConsoleApi["createModelPreset"]>[0],
      ) {
        this.lastPresetInput = input;
        return super.createModelPreset(input);
      }
    }
    const user = userEvent.setup();
    const api = new XAITrackingApi({ eventDelayMs: 60_000 });
    renderConsole("/models", api);
    await user.click(
      await screen.findByRole("button", { name: "Add model preset" }),
    );
    const preset = within(
      screen.getByRole("dialog", { name: "Add model preset" }),
    );
    const providerOption = preset.getByRole("option", {
      name: "xAI primary — xai",
    }) as HTMLOptionElement;
    await user.selectOptions(
      preset.getByLabelText("Provider connection"),
      providerOption.value,
    );
    const model = preset.getByRole("combobox", { name: /^Model/u });
    await user.click(model);
    await user.type(model, "grok");
    await user.click(await preset.findByRole("option", { name: /Grok 4\.6/u }));
    expect(preset.getByLabelText("Response format")).toHaveValue("text");
    expect(preset.getByLabelText("Reasoning effort")).toHaveValue("high");
    expect(
      preset.getByText(/Tools and the system prompt are configured/u),
    ).toBeInTheDocument();
    await user.selectOptions(preset.getByLabelText("Reasoning effort"), "low");
    await user.click(preset.getByRole("button", { name: "Add model preset" }));
    await waitFor(() =>
      expect(api.lastPresetInput?.settings).toEqual({
        textFormat: "text",
        effort: "low",
      }),
    );
    expect(
      await screen.findByText(/low reasoning · text response/u),
    ).toBeInTheDocument();
  });

  it("creates an API key and shows its secret only in the acknowledgement dialog", async () => {
    const user = userEvent.setup();
    renderConsole("/api-keys");
    await user.click(
      await screen.findByRole("button", { name: "Create API key" }),
    );
    const create = within(
      screen.getByRole("dialog", { name: "Create API key" }),
    );
    await user.type(create.getByLabelText("Name"), "Session integration");
    expect(
      create.getByRole("checkbox", { name: /^agent:write/u }),
    ).not.toBeChecked();
    expect(
      create.getByRole("checkbox", { name: /^session:write/u }),
    ).toBeChecked();
    await user.click(create.getByRole("button", { name: "Create API key" }));

    const save = within(screen.getByRole("dialog", { name: "Save API key" }));
    expect(save.getByRole("alert")).toHaveTextContent("Shown only once");
    expect(
      (save.getByLabelText("API key secret") as HTMLInputElement).value,
    ).toMatch(/^oao_/u);
    await user.click(save.getByRole("button", { name: "I’ve saved it" }));
    expect(await screen.findByText("Session integration")).toBeInTheDocument();
    expect(screen.queryByLabelText("API key secret")).not.toBeInTheDocument();
  });

  it("adds a project sandbox provider without redisplaying its secret", async () => {
    const user = userEvent.setup();
    renderConsole("/sandbox-providers");
    expect(
      await screen.findByRole("heading", { name: "Sandbox providers" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Sandbox providers" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add sandbox provider" }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Add sandbox provider" }),
    );
    expect(dialog.getByLabelText("Provider")).toHaveValue("daytona");
    await user.type(dialog.getByLabelText("Connection key"), "daytona-eu");
    await user.type(dialog.getByLabelText("Display name"), "Daytona EU");
    await user.type(
      dialog.getByLabelText("Daytona API key"),
      "daytona-secret-value",
    );
    await user.type(dialog.getByLabelText("Target preference"), "eu");
    await user.type(
      dialog.getByLabelText("Allowed domains"),
      "api.example.com",
    );
    await user.click(dialog.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText("Daytona EU")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("daytona-secret-value");
  });

  it("adds S3-compatible workspace storage without redisplaying credentials", async () => {
    const user = userEvent.setup();
    renderConsole("/storage-providers");
    expect(
      await screen.findByRole("heading", { name: "Storage providers" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add storage provider" }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Add storage provider" }),
    );
    await user.type(dialog.getByLabelText("Connection key"), "workspace-eu");
    await user.type(dialog.getByLabelText("Display name"), "Workspace EU");
    await user.type(
      dialog.getByLabelText("S3-compatible endpoint"),
      "https://objects.example.test",
    );
    await user.clear(dialog.getByLabelText("Region"));
    await user.type(dialog.getByLabelText("Region"), "eu-test-1");
    await user.type(dialog.getByLabelText("Bucket"), "oao-workspaces");
    await user.type(dialog.getByLabelText("Access key ID"), "access-key-value");
    await user.type(
      dialog.getByLabelText("Secret access key"),
      "secret-access-key-value",
    );
    await user.click(dialog.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText("Workspace EU")).toBeInTheDocument();
    expect(screen.getByText("oao-workspaces")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("access-key-value");
    expect(document.body.textContent).not.toContain("secret-access-key-value");
  });

  it("browses a storage provider's folders and files from settings", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    await api.createStorageProvider({
      key: "workspace-eu",
      displayName: "Workspace EU",
      providerType: "s3",
      endpoint: "https://objects.example.test",
      region: "eu-test-1",
      bucket: "oao-workspaces",
      prefix: "oao",
      forcePathStyle: false,
      setDefault: true,
      accessKeyId: "access-key-value",
      secretAccessKey: "secret-access-key-value",
    });
    renderConsole("/storage-providers", api);
    await user.click(await screen.findByRole("link", { name: "Workspace EU" }));
    expect(
      await screen.findByRole("heading", { name: "Workspace EU" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "run-files/" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "workspace-backups/" }));
    await user.click(await screen.findByRole("link", { name: "threads/" }));
    await user.click(
      await screen.findByRole("link", { name: "thread-demo-0001/" }),
    );
    expect(await screen.findByText("workspace.tar.gz")).toBeInTheDocument();
    expect(screen.getByText("1.1 MiB")).toBeInTheDocument();
    expect(screen.getByText("workspace.manifest.json")).toBeInTheDocument();
  });

  it("highlights the linked object when arriving from a session file", async () => {
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    const provider = await api.createStorageProvider({
      key: "workspace-eu",
      displayName: "Workspace EU",
      providerType: "s3",
      endpoint: null,
      region: "eu-test-1",
      bucket: "oao-workspaces",
      prefix: null,
      forcePathStyle: false,
      setDefault: true,
      accessKeyId: "access-key-value",
      secretAccessKey: "secret-access-key-value",
    });
    renderConsole(
      `/storage-providers/${provider.id}?prefix=${encodeURIComponent(
        "workspace-backups/threads/thread-demo-0001/",
      )}&highlight=workspace.tar.gz`,
      api,
    );
    expect(await screen.findByText("workspace.tar.gz")).toBeInTheDocument();
    expect(screen.getByText("selected")).toBeInTheDocument();
    const highlighted = screen
      .getByText("workspace.tar.gz")
      .closest("tr") as HTMLElement;
    expect(highlighted.className).toContain("storage-row--highlight");
  });

  it("publishes the selected Daytona snapshot and exact tool capabilities", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api);
    await openSection(user, "Sandbox policy");
    const provider = await screen.findByLabelText("Sandbox provider");
    expect(provider).toHaveValue("daytona-primary");
    const snapshot = await screen.findByLabelText("Daytona snapshot");
    await user.selectOptions(snapshot, "78787878-7878-4787-8787-787878787878");
    const shell = screen.getByRole("checkbox", {
      name: /^Shell and search/u,
    });
    expect(shell).toBeChecked();
    await user.click(shell);
    await user.click(
      screen.getByRole("button", { name: "Publish new version" }),
    );
    expect(await screen.findByText("Version 4")).toBeInTheDocument();
    const updated = await api.getAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(updated.versions[0]?.config.sandbox).toMatchObject({
      provider: "daytona-primary",
      snapshotId: "78787878-7878-4787-8787-787878787878",
      capabilities: ["filesystem_read", "filesystem_write", "browser"],
    });
  });

  it("authors rich tool schemas in the immutable version editor", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api);
    await openSection(user, "Sandbox policy");
    await screen.findByRole("option", { name: /daytona-small/u });
    await user.selectOptions(
      await screen.findByLabelText("Daytona snapshot"),
      "78787878-7878-4787-8787-787878787878",
    );
    const tools = [
      {
        schemaVersion: 1,
        name: "lookup_customer",
        description: "Look up one customer.",
        owner: "caller",
        approval: "always",
        inputSchema: {
          type: "object",
          properties: {
            customer: {
              type: "string",
              description: "Customer id or exact name.",
              minLength: 1,
            },
          },
          required: ["customer"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: true,
        },
      },
    ];
    // Tool authoring lives behind modals; the bulk JSON editor takes a paste.
    await user.click(screen.getByRole("button", { name: "Edit JSON" }));
    fireEvent.change(await screen.findByLabelText("Tool definitions (JSON)"), {
      target: { value: JSON.stringify(tools, null, 2) },
    });
    await user.click(screen.getByRole("button", { name: "Apply tools" }));
    // The Tools panel is collapsed by default; the applied tool shows once
    // it is expanded, with highlighted schema JSON.
    expect(
      screen.queryByRole("button", { name: /^lookup_customer/u }),
    ).not.toBeInTheDocument();
    const toolsToggle = screen.getByRole("button", { name: "Tools" });
    expect(toolsToggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toolsToggle);
    const toolRow = screen.getByRole("button", { name: /^lookup_customer/u });
    await user.click(toolRow);
    const schemaTokens = within(
      screen.getByLabelText("Input schema for lookup_customer"),
    ).getAllByText('"customer"');
    expect(
      schemaTokens.some((token) => token.classList.contains("jt-key")),
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Publish new version" }),
    );
    expect(await screen.findByText("Version 4")).toBeInTheDocument();
    const updated = await api.getAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const inputSchema = updated.versions[0]?.config.tools[0]?.inputSchema as {
      readonly properties?: unknown;
    };
    expect(inputSchema.properties).toMatchObject({
      customer: {
        description: "Customer id or exact name.",
        minLength: 1,
      },
    });
  });

  it("adds, edits, and removes one tool through the modal editor", async () => {
    const user = userEvent.setup();
    renderConsole(
      "/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      new DemoConsoleApi({ eventDelayMs: 60_000 }),
    );
    await user.click(await screen.findByRole("button", { name: "Add tool" }));
    let dialog = within(screen.getByRole("dialog"));
    const editor = dialog.getByLabelText("Tool definition (JSON)");
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify(
          {
            name: "notify_ops",
            description: "Page the on-call operator.",
            owner: "caller",
            approval: "always",
            inputSchema: { type: "object", properties: {} },
            outputSchema: { type: "object", properties: {} },
          },
          null,
          2,
        ),
      },
    });
    await user.click(dialog.getByRole("button", { name: "Add tool" }));
    // The new tool lands in the collapsed panel as a collapsible row.
    await user.click(screen.getByRole("button", { name: "Tools" }));
    const row = screen.getByRole("button", { name: /^notify_ops/u });
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Edit definition" }));
    dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Tool definition (JSON)"), {
      target: { value: "not json" },
    });
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Invalid tool JSON",
    );
    expect(dialog.getByRole("button", { name: "Save tool" })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("Tool definition (JSON)"), {
      target: {
        value: JSON.stringify({ name: "notify_ops_v2" }, null, 2),
      },
    });
    await user.click(dialog.getByRole("button", { name: "Save tool" }));
    expect(
      screen.getByRole("button", { name: /^notify_ops_v2/u }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^notify_ops_v2/u }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      screen.queryByRole("button", { name: /^notify_ops_v2/u }),
    ).not.toBeInTheDocument();
  });

  it("authors immutable Harness Operations without per-operation Skill controls", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api);
    await user.click(
      await screen.findByRole("button", { name: "Add operation" }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Add Harness Operation" }),
    );
    expect(dialog.getByRole("paragraph")).toHaveTextContent("task: string");
    expect(dialog.queryByLabelText(/Skill/u)).not.toBeInTheDocument();
    expect(dialog.queryByLabelText(/Model/u)).not.toBeInTheDocument();
    await user.clear(dialog.getByLabelText("Operation key"));
    await user.type(dialog.getByLabelText("Operation key"), "verify_order");
    await user.clear(
      dialog.getByLabelText("When should the orchestrator call it?"),
    );
    await user.type(
      dialog.getByLabelText("When should the orchestrator call it?"),
      "Verify extracted order facts against all shared documents.",
    );
    fireEvent.change(dialog.getByLabelText("Required result schema (JSON)"), {
      target: {
        value: JSON.stringify({
          type: "object",
          properties: { valid: { type: "boolean" } },
          required: ["valid"],
          additionalProperties: false,
        }),
      },
    });
    await user.click(dialog.getByRole("button", { name: "Add operation" }));
    await openSection(user, "Harness Operations");
    const operation = screen.getByRole("button", { name: /^verify_order/u });
    await user.click(operation);
    expect(
      screen.getByLabelText("Result schema for verify_order"),
    ).toHaveTextContent('"valid"');
    await user.click(
      screen.getByRole("button", { name: "Publish new version" }),
    );
    expect(await screen.findByText("Version 4")).toBeInTheDocument();
    const updated = await api.getAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(updated.versions[0]?.config.harnessOperations).toEqual([
      expect.objectContaining({
        key: "extract_shipment",
      }),
      expect.objectContaining({
        key: "verify_order",
        timeoutMs: 120_000,
        resultSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);
  });

  it("shows Harness Operation activity without prompts, results, or documents", async () => {
    const user = userEvent.setup();
    class HarnessActivityApi extends DemoConsoleApi {
      override async getSession(id: string) {
        const session = await super.getSession(id);
        return {
          ...session,
          events: [
            ...session.events.filter((event) => !event.harness),
            {
              id: "event-harness-1",
              kind: "tool" as const,
              source: "activity" as const,
              title: "Harness · extract_shipment",
              summary:
                "Validated structured result returned to the parent Agent.",
              createdAt: "2026-08-20T07:02:15.000Z",
              durationMs: 1_211,
              status: "success" as const,
              harness: {
                operationKey: "extract_shipment",
                toolCallId: "tool-call-1",
                phase: "completed",
                startedAt: "2026-08-20T07:02:13.789Z",
                completedAt: "2026-08-20T07:02:15.000Z",
                taskCharacters: 126,
                timeoutMs: 120_000,
                resultValidated: true,
                modelTurns: 2,
                toolSteps: 2,
                attribution: "complete" as const,
                steps: [
                  {
                    id: "inner-model-1",
                    kind: "reasoning" as const,
                    title: "Model turn 1",
                    summary: "The model completed an internal turn.",
                    createdAt: "2026-08-20T07:02:14.000Z",
                    durationMs: 210,
                    status: "success" as const,
                    tokens: { input: 42, output: 9 },
                  },
                  {
                    id: "inner-skill",
                    kind: "tool" as const,
                    title: "Skill activated",
                    summary: "shipment-extraction",
                    createdAt: "2026-08-20T07:02:14.220Z",
                    durationMs: 12,
                    status: "success" as const,
                  },
                  {
                    id: "inner-read",
                    kind: "tool" as const,
                    title: "read",
                    summary: "/workspace/order.pdf",
                    createdAt: "2026-08-20T07:02:14.300Z",
                    durationMs: 35,
                    status: "success" as const,
                  },
                  {
                    id: "inner-model-2",
                    kind: "reasoning" as const,
                    title: "Model turn 2",
                    summary: "The model completed an internal turn.",
                    createdAt: "2026-08-20T07:02:14.400Z",
                    durationMs: 500,
                    status: "success" as const,
                    tokens: { input: 64, output: 14 },
                  },
                ],
              },
              payload: {
                rendered: {
                  operationKey: "extract_shipment",
                  phase: "completed",
                  taskCharacters: 126,
                  timeoutMs: 120_000,
                  durationMs: 1_211,
                  resultValidated: true,
                },
                raw: null,
                redacted: true,
                redactionReason:
                  "Harness prompts, structured results, and document contents are not copied into product events.",
              },
            },
          ],
        };
      }
    }
    renderConsole(
      "/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V",
      new HarnessActivityApi({ eventDelayMs: 60_000 }),
    );
    const harness = (
      await screen.findAllByRole("button", {
        name: /Harness · extract_shipment/u,
      })
    ).find((button) => button.getAttribute("aria-haspopup") === "dialog")!;
    expect(harness).toBeInTheDocument();
    await user.click(harness);
    const dialog = await screen.findByRole("dialog", {
      name: "Harness · extract_shipment",
    });
    expect(within(dialog).getAllByText("2", { selector: "dd" })).toHaveLength(
      2,
    );
    expect(within(dialog).getByText("Model turn 1")).toBeInTheDocument();
    expect(within(dialog).getByText("Skill activated")).toBeInTheDocument();
    expect(
      within(dialog).getByText("/workspace/order.pdf"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Model turn 2")).toBeInTheDocument();
    expect(within(dialog).getByText("Result validated")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      "Read the materialized shipment documents",
    );
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("draws one shared rail before concurrently overlapping Harness rows", async () => {
    const user = userEvent.setup();
    renderConsole(
      "/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V",
      new DemoConsoleApi({ eventDelayMs: 60_000 }),
    );
    const extract = await screen.findByRole("button", {
      name: /Harness · extract_shipment 3 model turns/u,
    });
    const verify = screen.getByRole("button", {
      name: /Harness · verify_shipment 2 model turns/u,
    });
    expect(extract.closest("article")).toHaveClass(
      "activity--harness-parallel",
      "activity--harness-parallel-first",
    );
    expect(verify.closest("article")).toHaveClass(
      "activity--harness-parallel",
      "activity--harness-parallel-last",
    );
    expect(screen.getAllByText("2 parallel")).toHaveLength(2);

    await user.click(verify);
    const dialog = await screen.findByRole("dialog", {
      name: "Harness · verify_shipment",
    });
    expect(within(dialog).getByText("Parallel batch")).toBeInTheDocument();
    expect(within(dialog).getByText("2 of 2")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/overlapped another parallel/u),
    ).toBeInTheDocument();
  });

  it("can remove delegates made incompatible by a snapshot change and publish", async () => {
    class CoordinatorApi extends DemoConsoleApi {
      override async getAgent(id: string) {
        const agent = await super.getAgent(id);
        if (
          id !== "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" ||
          agent.version !== 3
        )
          return agent;
        return {
          ...agent,
          versions: agent.versions.map((version, index) =>
            index === 0
              ? {
                  ...version,
                  config: {
                    ...version.config,
                    delegates: [
                      {
                        key: "document-analyst",
                        description: "Extract facts from documents.",
                        agentVersionId: "bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        maxParallel: 1,
                      },
                    ],
                  },
                }
              : version,
          ),
        };
      }
    }

    const user = userEvent.setup();
    const api = new CoordinatorApi({ eventDelayMs: 60_000 });
    renderConsole("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api);
    await openSection(user, "Sandbox policy");
    await screen.findByRole("option", { name: /daytona-small/u });
    await user.selectOptions(
      await screen.findByLabelText("Daytona snapshot"),
      "78787878-7878-4787-8787-787878787878",
    );
    expect(
      screen.getByText(/Selected delegates do not match the draft sandbox/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish new version" }),
    ).toBeDisabled();
    await openSection(user, "Delegates");
    await user.click(
      screen.getByRole("button", { name: "Remove incompatible delegate" }),
    );
    const publish = screen.getByRole("button", {
      name: "Publish new version",
    });
    expect(publish).toBeEnabled();
    await user.click(publish);
    expect(await screen.findByText("Version 4")).toBeInTheDocument();
    const updated = await api.getAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(updated.versions[0]?.config.sandbox.snapshotId).toBe(
      "78787878-7878-4787-8787-787878787878",
    );
    expect(updated.versions[0]?.config.delegates).toEqual([]);
  });

  it("blocks sandbox-incompatible delegates before publication", async () => {
    class IncompatibleDelegateApi extends DemoConsoleApi {
      override async listAgents(
        filters: Parameters<DemoConsoleApi["listAgents"]>[0],
      ) {
        const result = await super.listAgents(filters);
        return {
          ...result,
          data: result.data.map((candidate) =>
            candidate.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
              ? {
                  ...candidate,
                  sandbox: candidate.sandbox
                    ? { ...candidate.sandbox, enabled: false }
                    : null,
                }
              : candidate,
          ),
        };
      }
    }
    const user = userEvent.setup();
    renderConsole(
      "/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      new IncompatibleDelegateApi({ eventDelayMs: 60_000 }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add delegate" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add delegates" });
    const delegate = within(dialog).getByRole("checkbox", {
      name: /Document analyst · v5/u,
    });
    expect(delegate).toBeDisabled();
    expect(
      within(dialog).getByText(
        /Unavailable — sandbox is disabled for this child, so it cannot share the coordinator workspace/u,
      ),
    ).toBeInTheDocument();
  });

  it("renders draft delegate candidates without a published sandbox policy", async () => {
    class DraftDelegateApi extends DemoConsoleApi {
      override async listAgents(
        filters: Parameters<DemoConsoleApi["listAgents"]>[0],
      ) {
        const result = await super.listAgents(filters);
        return {
          ...result,
          data: result.data.map((candidate) =>
            candidate.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
              ? {
                  ...candidate,
                  status: "draft" as const,
                  version: null,
                  latestVersionId: null,
                  sandbox: null,
                }
              : candidate,
          ),
        };
      }
    }
    const user = userEvent.setup();
    renderConsole(
      "/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      new DraftDelegateApi({ eventDelayMs: 60_000 }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add delegate" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add delegates" });
    const delegate = within(dialog).getByRole("checkbox", {
      name: /Document analyst · draft/u,
    });
    expect(delegate).toBeDisabled();
    expect(
      within(dialog).getByText(
        /Unavailable — this child does not have a published sandbox policy/u,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/No published version is available/u),
    ).toBeInTheDocument();
  });

  it("lists only linked delegates and adds more through a searchable dialog", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    renderConsole("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api);
    await screen.findByRole("button", { name: "Add delegate" });
    // The panel no longer enumerates every candidate as a checkbox.
    expect(
      screen.queryByRole("checkbox", { name: /Document analyst · v5/u }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("No delegates linked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add delegate" }));
    const dialog = screen.getByRole("dialog", { name: "Add delegates" });
    expect(
      within(dialog).getByRole("button", { name: "Add delegate" }),
    ).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText("Search agents"),
      "zzz-no-such-agent",
    );
    expect(within(dialog).getByText("No matching agents")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Search agents"));
    await user.type(within(dialog).getByLabelText("Search agents"), "analyst");
    await user.click(
      within(dialog).getByRole("checkbox", { name: /Document analyst · v5/u }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add delegate" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Add delegates" }),
    ).not.toBeInTheDocument();

    await openSection(user, "Delegates");
    const linked = screen.getByRole("list", { name: "Linked delegates" });
    expect(within(linked).getByText("Document analyst")).toBeInTheDocument();
    expect(
      within(linked).getByText(/Sandbox-compatible with this coordinator/u),
    ).toBeInTheDocument();
    // Already-linked agents are not offered again.
    await user.click(screen.getByRole("button", { name: "Add delegate" }));
    expect(
      within(screen.getByRole("dialog", { name: "Add delegates" })).queryByRole(
        "checkbox",
        { name: /Document analyst · v5/u },
      ),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    await user.click(
      within(linked).getByRole("button", {
        name: "Remove delegate Document analyst",
      }),
    );
    expect(screen.getByText("No delegates linked")).toBeInTheDocument();
  });

  it("creates a model preset from the provider catalog and links it to a new agent version", async () => {
    const user = userEvent.setup();
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    const view = renderConsole("/models", api);
    await user.click(
      await screen.findByRole("button", { name: "Add model preset" }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Add model preset" }),
    );

    // Searching the catalog fills the preset key and display name.
    const model = dialog.getByRole("combobox", { name: /^Model/u });
    await user.click(model);
    await user.type(model, "gpt");
    await user.click(await dialog.findByRole("option", { name: /GPT-5\.1/u }));
    expect(dialog.getByLabelText(/^Preset key/u)).toHaveValue("gpt-5-1-v1");
    expect(dialog.getByLabelText(/^Display name/u)).toHaveValue("GPT-5.1");

    await user.clear(dialog.getByLabelText(/^Preset key/u));
    await user.type(dialog.getByLabelText(/^Preset key/u), "no-version");
    expect(
      await dialog.findByText(/must be lowercase, hyphen separated/u),
    ).toBeInTheDocument();
    await user.clear(dialog.getByLabelText(/^Preset key/u));
    await user.type(dialog.getByLabelText(/^Preset key/u), "gpt-5-1-fast-v1");
    await user.clear(dialog.getByLabelText(/^Display name/u));
    await user.type(dialog.getByLabelText(/^Display name/u), "GPT-5.1 fast");

    // Routing controls stay folded away until they are needed.
    await user.click(dialog.getByText("Routing and data policy"));
    await user.selectOptions(
      dialog.getByLabelText(/^Route preference/u),
      "latency",
    );
    await user.type(dialog.getByLabelText(/^Provider allowlist/u), "openai");
    await user.click(
      screen.getAllByRole("button", { name: "Add model preset" }).at(-1)!,
    );
    expect(await screen.findByText("GPT-5.1 fast")).toBeInTheDocument();
    view.unmount();

    renderConsole("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api);
    const preset = await screen.findByRole("combobox", {
      name: /Approved model preset/u,
    });
    await user.click(preset);
    await user.type(preset, "gpt-5-1-fast");
    await user.click(
      await screen.findByRole("option", { name: /GPT-5\.1 fast/u }),
    );
    expect(
      await screen.findByText("openrouter/openai/gpt-5.1"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Publish new version" }),
    );
    expect(await screen.findByText("Version 4")).toBeInTheDocument();
  });

  it("blocks publishing an agent version against an unapproved preset", async () => {
    const api = new DemoConsoleApi({ eventDelayMs: 60_000 });
    await expect(
      api.publishAgentVersion("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        systemPrompt: "Answer support questions carefully.",
        modelPreset: "never-approved-v1",
        tools: [],
        sandbox: {
          enabled: false,
          provider: "local-fake",
          network: "none",
          capabilities: ["filesystem_read", "filesystem_write", "shell"],
        },
        limits: { maxTurns: 32, timeoutMs: 60_000 },
      }),
    ).rejects.toThrow(/not an approved model preset/u);
  });

  it("revalidates session queries after a resumable product event", async () => {
    class CountingApi extends DemoConsoleApi {
      calls = 0;
      override async listSessions(
        filters: Parameters<DemoConsoleApi["listSessions"]>[0],
      ) {
        this.calls += 1;
        return super.listSessions(filters);
      }
    }
    const api = new CountingApi({ eventDelayMs: 5 });
    renderConsole("/sessions", api);
    expect(
      await screen.findByText("Q3 contract extraction"),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toBeGreaterThan(1));
    expect(
      sessionStorage.getItem(
        "oao:event-cursor:22222222-2222-4222-8222-222222222222",
      ),
    ).toBe("djE6NDI");
  });
});
