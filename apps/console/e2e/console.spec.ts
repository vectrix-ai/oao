import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    results.violations,
    results.violations
      .map((violation) => `${violation.id}: ${violation.help}`)
      .join("\n"),
  ).toEqual([]);
}

test("agents and filtering smoke", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByText("Support operator")).toBeVisible();
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByLabel(/^Approved model preset/)).toBeVisible();
  await expect(
    page.getByText(
      "Claude Sonnet 4.6 (zero retention) · openrouter/anthropic/claude-sonnet-4.6",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("searchbox", { name: "Search agents" })
    .fill("missing agent");
  await expect(
    page.getByRole("heading", { name: "No matching agents" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.goto("/sessions");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByText("Q3 contract extraction")).toBeVisible();
  await expectAccessible(page);
});

test("models catalog and preset creation smoke", async ({ page }) => {
  await page.goto("/models");
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  await expect(
    page.getByText("Claude Sonnet 4.6 (zero retention)"),
  ).toBeVisible();
  await expect(page.getByText("project", { exact: true })).toBeVisible();
  await expect(page.getByText("OpenRouter primary")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Add provider" }).click();
  const providerDialog = page.getByRole("dialog", {
    name: "Add model provider",
  });
  await providerDialog.getByLabel("Provider type").selectOption("openai");
  await providerDialog.getByLabel(/^Connection key/).fill("openai-primary");
  await providerDialog.getByLabel("Display name").fill("OpenAI primary");
  await providerDialog.getByLabel(/^API key/).fill("sk-openai-e2e-secret");
  await providerDialog.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByText("OpenAI primary")).toBeVisible();
  await expect(page.getByText("sk-openai-e2e-secret")).toHaveCount(0);

  await page.getByRole("button", { name: "Add model preset" }).click();
  const dialog = page.getByRole("dialog", { name: "Add model preset" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);

  const model = dialog.getByRole("combobox", { name: /^Model/ });
  await model.click();
  await expect(
    dialog.getByRole("listbox", { name: "Model options" }),
  ).toBeVisible();
  await expectAccessible(page);
  await model.fill("gpt");
  await dialog
    .getByRole("option", { name: /GPT-5\.1/ })
    .first()
    .click();
  await expect(dialog.getByLabel(/^Preset key/)).toHaveValue("gpt-5-1-v1");
  await dialog.getByLabel(/^Preset key/).fill("gpt-5-1-fast-v1");
  await dialog.getByLabel(/^Display name/).fill("GPT-5.1 fast");
  await dialog.getByRole("button", { name: "Add model preset" }).click();
  await expect(page.getByText("GPT-5.1 fast")).toBeVisible();

  await page.goto("/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const preset = page.getByRole("combobox", {
    name: /^Approved model preset/,
  });
  await expect(preset).toBeVisible();
  // A reload resets the demo adapter, so this picks a seeded project preset.
  await preset.click();
  await page
    .getByRole("option", { name: /^Claude Sonnet 4\.6 \(zero retention\)/ })
    .click();
  await expect(preset).toHaveValue("Claude Sonnet 4.6 (zero retention)");
  await expectAccessible(page);
});

test("API key creation exposes the secret once", async ({ page }) => {
  await page.goto("/api-keys");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await page.getByRole("button", { name: "Create API key" }).click();
  const create = page.getByRole("dialog", { name: "Create API key" });
  await create.getByLabel("Name").fill("Browser integration");
  await expect(
    create.getByRole("checkbox", { name: /^session:write/ }),
  ).toBeChecked();
  await expectAccessible(page);
  await create.getByRole("button", { name: "Create API key" }).click();

  const save = page.getByRole("dialog", { name: "Save API key" });
  await expect(save.getByRole("alert")).toContainText("Shown only once");
  await expect(save.getByLabel("API key secret")).toHaveValue(/^oao_/u);
  await expectAccessible(page);
  await save.getByRole("button", { name: "I’ve saved it" }).click();
  await expect(page.getByText("Browser integration")).toBeVisible();
  await expect(page.getByLabel("API key secret")).toHaveCount(0);
});

test("session transcript and debug inspector smoke", async ({ page }) => {
  await page.goto("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
  await expect(
    page.getByRole("heading", { name: "Refund request · Northwind #4831" }),
  ).toBeVisible();
  // Tool calls are one line until expanded in place.
  const toolRow = page.getByRole("button", { name: /^lookup_customer/u });
  await expect(toolRow).toHaveAttribute("aria-expanded", "false");
  await toolRow.click();
  await page.getByRole("tab", { name: "Raw" }).click();
  await expect(page.getByText(/customer_ref/u)).toBeVisible();
  // Platform telemetry never reaches the transcript, only the debug timeline.
  await expect(
    page.getByRole("button", { name: /dispatch admitted/u }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy thread as Markdown" }),
  ).toBeVisible();
  // The session panel rides beside the conversation with cost and usage.
  const panel = page.getByRole("complementary", { name: "Session details" });
  await expect(panel.getByText("$0.0184")).toBeVisible();
  await expect(
    panel.getByRole("img", { name: /Cumulative cost/u }),
  ).toBeVisible();
  // The minimap is a contiguous state strip with striped idle segments,
  // a hover card naming the state, and click-to-jump.
  const minimap = page.getByRole("group", { name: "Session timeline" });
  await expect(
    minimap.getByRole("img", { name: /^Idle for/u }).first(),
  ).toBeVisible();
  const userSeg = minimap.getByRole("button", { name: /^Jump to User/u });
  await userSeg.hover();
  await expect(page.locator(".minimap-tip")).toContainText("Northwind #4831");
  await userSeg.click();
  await expect(page.locator("#event-event-user-1")).toBeInViewport();
  // Hovering a message lights its block on the timeline; only the message
  // pane scrolls while the header stack stays pinned.
  await page.locator("#event-event-user-1").hover();
  await expect(page.locator(".minimap-seg--hot")).toBeVisible();
  const pinned = await page.evaluate(() => ({
    docScrollable:
      document.documentElement.scrollHeight > window.innerHeight + 2,
    paneScrollable: (() => {
      const pane = document.querySelector(".conversation-scroll");
      return pane ? pane.scrollHeight >= pane.clientHeight : false;
    })(),
  }));
  expect(pinned.docScrollable).toBe(false);
  expect(pinned.paneScrollable).toBe(true);
  await page.getByRole("tab", { name: "Debug" }).click();
  await expect(
    page.getByRole("button", { name: /^Inspect runtime\.dispatch admitted/u }),
  ).toBeVisible();
  await expect(page.getByText("Provider request failed").first()).toBeVisible();
  await expectAccessible(page);
});

test("pending work and deterministic empty/error scenarios", async ({
  page,
}) => {
  await page.goto("/pending-work");
  await expect(
    page.getByRole("button", { name: "Claim request" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Claim request" }).click();
  await expect(
    page.getByRole("button", { name: "Submit result" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.goto("/agents?demo=empty");
  await expect(
    page.getByRole("heading", { name: "No agents yet" }),
  ).toBeVisible();
  await page.goto("/agents?demo=error");
  await expect(page.getByRole("alert")).toContainText(
    "demo service is temporarily unavailable",
  );
});
