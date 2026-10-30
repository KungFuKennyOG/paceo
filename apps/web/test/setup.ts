import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* storage may be unavailable */
  }
});
