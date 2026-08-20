import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Combobox, Field, type ComboboxOption } from "../src/components/ui";

const catalog: readonly ComboboxOption[] = Array.from(
  { length: 24 },
  (_unused, index) => ({
    value: `provider/model-${index}`,
    label: `Model ${index}`,
    description: `provider/model-${index}`,
  }),
);

function Harness({
  options = catalog,
  onSearchChange,
}: {
  readonly options?: readonly ComboboxOption[];
  readonly onSearchChange?: (term: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Field label="Model">
      <Combobox
        label="Model"
        value={value}
        options={options}
        onChange={setValue}
        {...(onSearchChange ? { onSearchChange, searchDebounceMs: 5 } : {})}
      />
    </Field>
  );
}

describe("Combobox", () => {
  it("renders only the first matches and reports the withheld ones", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getByText(/Showing 8 of 24/u)).toBeInTheDocument();
  });

  it("narrows the list by search and keeps the chosen label", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const control = screen.getByRole("combobox", { name: "Model" });
    await user.click(control);
    await user.type(control, "model-17");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText(/Showing/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Model 17/u }));
    expect(control).toHaveValue("Model 17");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("walks the list with the keyboard and skips unselectable options", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", disabled: true },
          { value: "c", label: "Gamma" },
        ]}
      />,
    );
    const control = screen.getByRole("combobox", { name: "Model" });
    await user.click(control);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(control).toHaveValue("Gamma");
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Beta" }));
    // The click is ignored, so the list stays open with the earlier choice.
    expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(control).toHaveValue("Gamma");
  });

  it("closes the list on Escape without clearing the selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const control = screen.getByRole("combobox", { name: "Model" });
    await user.click(control);
    await user.click(screen.getByRole("option", { name: /Model 3\b/u }));
    await user.click(control);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(control).toHaveValue("Model 3");
  });

  it("delegates filtering upstream when a search handler is supplied", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    render(
      <Harness
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onSearchChange={onSearchChange}
      />,
    );
    const control = screen.getByRole("combobox", { name: "Model" });
    await user.click(control);
    await user.type(control, "gamma");
    // The upstream query owns the matching, so the given options stay listed.
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith("gamma"));
  });
});
