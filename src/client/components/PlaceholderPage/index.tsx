import Box from "@mui/material/Box";
import { t } from "../../lib/i18n";
import { EmptyState } from "../EmptyState";

export interface PlaceholderPageProps {
  /** The destination's title. */
  name: string;
  /** An extra line under "Coming soon". */
  note?: string;
  /** Inside the frame the header carries the h1; a page outside the frame passes "h1". */
  headingLevel?: "h1" | "h2";
}

/**
 * What a destination shows until its feature lands: its title and "Coming soon". A placeholder
 * feature module renders this from a real route, so the destination never falls to not-found.
 */
export function PlaceholderPage({ name, note, headingLevel = "h2" }: PlaceholderPageProps) {
  return (
    <Box data-placeholder-page={name} sx={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
      <EmptyState
        type="cleared"
        headingLevel={headingLevel}
        title={name}
        body={
          <>
            {t("placeholder.body")}
            {note ? (
              <>
                <br />
                {note}
              </>
            ) : null}
          </>
        }
      />
    </Box>
  );
}
