// What the details panel (desktop) and the details sheet (mobile) show for the explorer.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import type { NodeDto } from "../../../shared/schemas/node";
import { Bytes } from "../../components/Bytes";
import { FileBadge, FolderGlyph } from "../../components/FileBadge";
import { RelativeTime } from "../../components/RelativeTime";
import { StatusDot } from "../../components/StatusDot";
import { formatBytes } from "../../lib/format";
import { hf } from "../../theme/tokens";
import { kindLabel, scanSentence, sharingSentence } from "./model";
import { t } from "./strings";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
      <Box component="dt" sx={{ color: hf.textSecondary, typography: "body2" }}>
        {label}
      </Box>
      <Box component="dd" sx={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>
        {children}
      </Box>
    </Box>
  );
}

export interface NodeDetailsProps {
  node: NodeDto;
  /** Present when the caller may ask for another scan of this file. */
  onRecheck?(): void;
}

/** One file or folder: size, type, dates, digest, scan status in plain English, sharing. */
export function NodeDetails({ node, onRecheck }: NodeDetailsProps) {
  const file = node.kind === "file";
  return (
    <Box
      data-explorer-details={node.id}
      sx={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 3, minWidth: 0 }}>
        {file ? (
          <FileBadge name={node.name} mimeCategory={node.mimeCategory} size={32} />
        ) : (
          <FolderGlyph size={24} />
        )}
        <Typography component="h2" sx={{ margin: 0, typography: "h2", overflowWrap: "anywhere" }}>
          {node.name}
        </Typography>
      </Box>
      <Box component="dl" sx={{ display: "flex", flexDirection: "column", gap: 3, margin: 0 }}>
        <Row label={t("explorer.details.type")}>{kindLabel(node)}</Row>
        {file ? (
          <Row label={t("explorer.details.size")}>
            <Bytes value={node.size} />
          </Row>
        ) : null}
        <Row label={t("explorer.details.modified")}>
          <RelativeTime value={node.updatedAt} />
        </Row>
        <Row label={t("explorer.details.created")}>
          <RelativeTime value={node.createdAt} />
        </Row>
        {file && node.sha256 ? (
          <Row label={t("explorer.details.sha256")}>
            <Box component="span" className="mono" data-sha256>
              {node.sha256}
            </Box>
          </Row>
        ) : null}
        {file ? (
          <Row label={t("explorer.details.scan")}>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }} data-scan-line={node.scanStatus}>
              <StatusDot status={node.scanStatus} reason={node.scanReason} variant="glyph" />
              <span>{scanSentence(node)}</span>
            </Box>
            {onRecheck ? (
              <Button onClick={onRecheck} sx={{ marginTop: 2 }} data-recheck>
                {t("explorer.action.recheck")}
              </Button>
            ) : null}
          </Row>
        ) : null}
        <Row label={t("explorer.details.sharing")}>
          {node.role === "owner"
            ? sharingSentence(node.sharing)
            : t(node.role === "editor" ? "explorer.sharing.youEdit" : "explorer.sharing.youView", {
                owner: node.owner.displayName,
              })}
        </Row>
      </Box>
    </Box>
  );
}

/** Several items selected: how many, and how much the files among them weigh. */
export function SelectionDetails({ nodes }: { nodes: readonly NodeDto[] }) {
  const files = nodes.filter((node) => node.kind === "file");
  const bytes = files.reduce((sum, node) => sum + node.size, 0);
  return (
    <Box data-explorer-details="selection" sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography component="h2" sx={{ margin: 0, typography: "h2" }}>
        {t("explorer.item.count", { count: nodes.length })}
      </Typography>
      <Box sx={{ color: hf.textSecondary }}>
        {t("explorer.details.selection", {
          files: files.length,
          folders: nodes.length - files.length,
          size: formatBytes(bytes),
        })}
      </Box>
    </Box>
  );
}
