import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatPace } from "@paceo/engine";

describe("smoke", () => {
  it("renders and formats", () => {
    render(<p>{formatPace(300, "imperial")}</p>);
    expect(screen.getByText("8:03 /mi")).toBeInTheDocument();
  });
});
