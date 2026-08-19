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

test("session transcript and debug inspector smoke", async ({ page }) => {
  await page.goto("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
  await expect(
    page.getByRole("heading", { name: "Refund request · Northwind #4831" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect lookup_customer" }).click();
  await page.getByRole("tab", { name: "Raw" }).click();
  await expect(page.getByText(/customer_ref/u)).toBeVisible();
  await page.getByRole("tab", { name: "Debug" }).click();
  await expect(page.getByText("Provider request failed")).toBeVisible();
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
