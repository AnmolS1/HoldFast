import Box from "@mui/material/Box";
import { formatDate, formatRelative } from "../../lib/format";
import { useSession } from "../../lib/query";

export interface RelativeTimeProps {
  value: string | number | Date;
  /** "relative" = "3 minutes ago"; "date" = "Oct 02" (the list column). */
  variant?: "relative" | "date";
  /** Overrides the account's time zone (tests, public pages). */
  timeZone?: string | null;
}

/** A date in the account's time zone (falling back to the browser's), with the exact time as title. */
export function RelativeTime({ value, variant = "relative", timeZone }: RelativeTimeProps) {
  const session = useSession();
  const zone = timeZone === undefined ? session.data?.user.timezone : timeZone;
  const date = value instanceof Date ? value : new Date(value);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  return (
    <Box
      component="time"
      className="mono"
      sx={{ whiteSpace: "nowrap", flex: "none" }}
      dateTime={iso}
      title={formatDate(value, { timeZone: zone, style: "dateTime" })}
    >
      {variant === "date" ? formatDate(value, { timeZone: zone }) : formatRelative(value, { timeZone: zone })}
    </Box>
  );
}
