// R1 a11y-7: the admin grid's column headers — its sort buttons — are 44 px tall (D01 §7's touch
// target). The grid sizes them in script from the theme's `columnHeaderHeight` and its compact
// density; the height it lays out with is the one it publishes as --DataGrid-headerHeight.
import { ThemeProvider } from "@mui/material/styles";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminDataGrid } from "../../../../src/client/features/admin/components/AdminDataGrid";
import { createHoldfastTheme } from "../../../../src/client/theme/theme";

const headerHeight = () =>
  document.querySelector<HTMLElement>(".MuiDataGrid-root")?.style.getPropertyValue("--DataGrid-headerHeight");

describe("admin grid column headers", () => {
  it("under the app's theme: 44 px", () => {
    render(
      <ThemeProvider theme={createHoldfastTheme()}>
        <AdminDataGrid rows={[{ id: 1, name: "a" }]} columns={[{ field: "name" }]} />
      </ThemeProvider>,
    );
    expect(headerHeight()).toBe("44px");
  });

  it("the control: without the theme the compact grid's header is the 39 px that was measured", () => {
    render(<AdminDataGrid rows={[{ id: 1, name: "a" }]} columns={[{ field: "name" }]} />);
    expect(headerHeight()).toBe("39px");
  });
});
