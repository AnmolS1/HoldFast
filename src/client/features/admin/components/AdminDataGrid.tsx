// The ONE door to the MUI X Data Grid (S-4; spike S5). The grid inserts a <style> of its own CSS
// variables outside Emotion, so under T26's policy it needs the page's CSP nonce — the same
// `<meta name="csp-nonce">` the Emotion cache reads (theme/emotion.ts). No other file imports
// `DataGrid` (eslint `no-restricted-imports`, and a source scan in tests/unit/client/admin).
import { DataGrid, type DataGridProps, type GridValidRowModel } from "@mui/x-data-grid";
import { readNonceFromMeta } from "../../../theme/emotion";

export type { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";

export function AdminDataGrid<R extends GridValidRowModel>(props: Omit<DataGridProps<R>, "nonce">) {
  return (
    <DataGrid<R>
      density="compact"
      disableRowSelectionOnClick
      hideFooter
      autoHeight
      {...props}
      nonce={readNonceFromMeta()}
    />
  );
}
