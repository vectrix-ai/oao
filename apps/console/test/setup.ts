import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
  if (typeof localStorage !== "undefined") localStorage.clear();
  if (typeof document !== "undefined")
    delete document.documentElement.dataset.theme;
});
