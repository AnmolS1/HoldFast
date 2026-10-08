// Proves the jsdom project renders React with Testing Library and user-event.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>clicked {count}</button>;
}

describe("jsdom project", () => {
  it("has a DOM", () => {
    expect(typeof window).toBe("object");
    expect(navigator.userAgent).toContain("jsdom");
  });

  it("renders a component and handles a click", async () => {
    render(<Counter />);
    await userEvent.click(screen.getByRole("button", { name: "clicked 0" }));
    expect(screen.getByRole("button").textContent).toBe("clicked 1");
  });

  it("starts each test with an empty document", () => {
    expect(document.body.childElementCount).toBe(0);
  });
});
