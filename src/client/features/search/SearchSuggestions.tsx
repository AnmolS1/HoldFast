import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import { FileBadge } from "../../components/FileBadge";
import type { SearchSuggestionsProps } from "../../components/slots";
import { MOBILE_QUERY } from "../../theme/breakpoints";
import { hf, layout } from "../../theme/tokens";
import { SUGGESTION_LIMIT, useDebounced, useSuggestions } from "./queries";
import { t } from "./strings";
import { Q_MAX } from "./url-state";

/**
 * The top matches under the header's search box: at most five files, each opening its preview.
 * Renders nothing until there is something to suggest — while typing, loading, or on an error.
 */
export function SearchSuggestions({ query, onPick }: SearchSuggestionsProps) {
  const q = useDebounced(query.trim().slice(0, Q_MAX));
  const suggestions = useSuggestions(q);
  const items = suggestions.data?.items.slice(0, SUGGESTION_LIMIT) ?? [];
  if (items.length === 0) return null;
  return (
    <Box
      component="ul"
      aria-label={t("search.suggestions")}
      sx={{
        listStyle: "none",
        margin: "4px 0 0",
        padding: 1,
        border: `1px solid ${hf.hairline}`,
        borderRadius: `${layout.radius.card}px`,
        backgroundColor: hf.surface,
      }}
    >
      {items.map((item) => (
        <li key={item.id}>
          <ButtonBase
            onClick={() => onPick(item.id)}
            data-suggestion={item.id}
            sx={{
              display: "flex",
              justifyContent: "flex-start",
              alignItems: "center",
              gap: "10px",
              width: "100%",
              minHeight: layout.rowHeight,
              padding: "0 8px",
              borderRadius: `${layout.radius.control}px`,
              font: "inherit",
              textAlign: "left",
              "&:hover, &.Mui-focusVisible": { backgroundColor: hf.surface2 },
              [`@media ${MOBILE_QUERY}`]: { minHeight: layout.touchRowHeight },
            }}
          >
            <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={16} />
            <Box
              component="span"
              sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
            >
              {item.name}
            </Box>
            {item.pathHint ? (
              <Box
                component="span"
                sx={{
                  color: hf.textSecondary,
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: "0 1 auto",
                }}
              >
                {item.pathHint}
              </Box>
            ) : null}
          </ButtonBase>
        </li>
      ))}
    </Box>
  );
}
