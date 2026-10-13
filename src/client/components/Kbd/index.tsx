import Box from "@mui/material/Box";
import type { ReactNode } from "react";
import { fontMono, hf } from "../../theme/tokens";

/** A key cap: mono 11 px, hairline box. Menus and the palette show shortcuts with it. */
export function Kbd({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  return (
    <Box
      component="kbd"
      sx={{
        fontFamily: fontMono,
        fontSize: 11,
        lineHeight: "18px",
        color: "inherit",
        // No dimming: at 80 % a bare hint on the selection bar's wash is 3.7:1 (AA needs 4.5:1).
        whiteSpace: "nowrap",
        ...(bare
          ? {}
          : {
              color: hf.textSecondary,
              border: `1px solid ${hf.hairline}`,
              borderRadius: "4px",
              padding: "0 5px",
              backgroundColor: hf.surface,
            }),
      }}
    >
      {children}
    </Box>
  );
}
