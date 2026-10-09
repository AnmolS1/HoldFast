import Box from "@mui/material/Box";
import { formatBytes } from "../../lib/format";

/** A size in user units, mono with tabular numerals. */
export function Bytes({ value }: { value: number | null | undefined }) {
  return (
    <Box component="span" className="mono">
      {formatBytes(value)}
    </Box>
  );
}
