import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { Bytes } from "../../../components/Bytes";
import { FileBadge } from "../../../components/FileBadge";
import { StatusDot } from "../../../components/StatusDot";
import { hf } from "../../../theme/tokens";
import { typeLabel } from "../labels";
import type { LoadedItem } from "../source";

export interface NoPreviewProps {
  item: LoadedItem;
  /** The one sentence that says why there is no preview. */
  message: string;
  /** Said under the status: the unscanned warning. */
  warning?: string;
}

/** The file as a card: glyph, type, size, its scan status in words. Download is the header's. */
export function NoPreview({ item, message, warning }: NoPreviewProps) {
  return (
    <Box
      data-preview-renderer="none"
      sx={{
        flex: "1 1 auto",
        minHeight: 240,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        padding: 8,
        textAlign: "center",
      }}
    >
      <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={56} />
      <Typography sx={{ color: hf.textSecondary, display: "flex", gap: 2, alignItems: "baseline" }}>
        <span>{typeLabel(item)}</span>
        <Bytes value={item.size} />
      </Typography>
      <StatusDot status={item.scanStatus} reason={item.scanReason} variant="sentence" />
      <Typography sx={{ maxWidth: 360 }}>{message}</Typography>
      {warning ? (
        <Typography variant="body2" sx={{ maxWidth: 360, color: hf.textSecondary }}>
          {warning}
        </Typography>
      ) : null}
    </Box>
  );
}
