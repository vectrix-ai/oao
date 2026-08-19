import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ConsoleApp } from "../src/app";
import { DemoConsoleApi } from "../src/api/context";

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
  it("lists agents and applies search filters", async () => {
    const user = userEvent.setup();
    renderConsole("/agents");
    expect(
      await screen.findByRole("heading", { name: "Agents" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Support operator")).toBeInTheDocument();
    await user.type(
      screen.getByRole("searchbox", { name: "Search agents" }),
      "not-a-real-agent",
    );
    expect(
      await screen.findByRole("heading", { name: "No matching agents" }),
    ).toBeInTheDocument();
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

  it("shows transcript, debug waterfall, filters, and safe payload views", async () => {
    const user = userEvent.setup();
    renderConsole("/sessions/session_01J5QTXE7W9M2R6C4A8K3N1P0V");
    expect(
      await screen.findByRole("heading", {
        name: "Refund request · Northwind #4831",
      }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Inspect lookup_customer" }),
    );
    expect(
      screen.getByRole("heading", { name: "lookup_customer" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByText(/"customer_ref":"NW-4831"/u)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Debug" }));
    expect(screen.getByText("10,004 ms")).toBeInTheDocument();
    await user.type(
      screen.getByRole("searchbox", { name: "Search events" }),
      "does-not-exist",
    );
    expect(
      screen.getByRole("heading", { name: "No matching events" }),
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Refund USD 84.50 to the original payment method"),
      ).not.toBeInTheDocument(),
    );
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
    expect(sessionStorage.getItem("oao:event-cursor")).toBe("djE6NDI");
  });
});
