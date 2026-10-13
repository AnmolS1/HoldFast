// The results page. Its state is its address (url-state.ts): typing rewrites `q` after a pause,
// the two menus rewrite `category` and `scope` at once.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router";
import { BottomSheet } from "../../components/BottomSheet";
import { EmptyState } from "../../components/EmptyState";
import { useIsDesktop } from "../../theme/breakpoints";
import { hf } from "../../theme/tokens";
import { ListNotice, NodeList, ViewError, ViewPage } from "../starred/view-kit";
import { canLoadMore, hasFailed, isWaitingOffline, useLoadMore } from "../starred/view-state";
import { DEBOUNCE_MS, useSearch } from "./queries";
import { t } from "./strings";
import {
  isSearchable,
  parseSearch,
  Q_MAX,
  SEARCH_CATEGORIES,
  SEARCH_SCOPES,
  searchParamsOf,
  type SearchScope,
  type SearchState,
} from "./url-state";

const CATEGORY_LABEL = {
  image: "search.type.image",
  video: "search.type.video",
  audio: "search.type.audio",
  pdf: "search.type.pdf",
  document: "search.type.document",
  archive: "search.type.archive",
  code: "search.type.code",
  other: "search.type.other",
} as const satisfies Record<(typeof SEARCH_CATEGORIES)[number], string>;

const SCOPE_LABEL = {
  all: "search.scope.all",
  mine: "search.scope.mine",
  shared: "search.scope.shared",
} as const satisfies Record<SearchScope, string>;

const ANY = "";

/** Marks an address this page wrote from its own box (see the note on `typed` below). */
const OWN_WRITE = { searchBox: true } as const;
const isOwnWrite = (state: unknown): boolean =>
  typeof state === "object" && state !== null && (state as { searchBox?: unknown }).searchBox === true;

interface FiltersProps {
  state: SearchState;
  onChange(patch: Partial<SearchState>): void;
  fullWidth?: boolean;
}

/** One menu for the type and one for where to look — two selects, not a row of chips. */
function Filters({ state, onChange, fullWidth = false }: FiltersProps) {
  return (
    <>
      <TextField
        select
        size="small"
        fullWidth={fullWidth}
        margin={fullWidth ? "normal" : "none"}
        label={t("search.type")}
        value={state.category ?? ANY}
        onChange={(event) => {
          const value = event.target.value;
          onChange({ category: SEARCH_CATEGORIES.find((category) => category === value) ?? null });
        }}
        slotProps={{ select: { native: true }, htmlInput: { "data-search-type": "" } }}
      >
        <option value={ANY}>{t("search.type.any")}</option>
        {SEARCH_CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {t(CATEGORY_LABEL[category])}
          </option>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        fullWidth={fullWidth}
        margin={fullWidth ? "normal" : "none"}
        label={t("search.scope")}
        value={state.scope}
        onChange={(event) => {
          const value = event.target.value;
          onChange({ scope: SEARCH_SCOPES.find((scope) => scope === value) ?? "all" });
        }}
        slotProps={{ select: { native: true }, htmlInput: { "data-search-scope": "" } }}
      >
        {SEARCH_SCOPES.map((scope) => (
          <option key={scope} value={scope}>
            {t(SCOPE_LABEL[scope])}
          </option>
        ))}
      </TextField>
    </>
  );
}

export function SearchPage() {
  const desktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseSearch(params), [params]);
  const search = useSearch(state);
  const location = useLocation();
  const navigationType = useNavigationType();
  const loadMore = useLoadMore(search.fetchNextPage);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [sheet, setSheet] = useState(false);

  // The box is the source of truth while the user types: `typed` is what it holds, the address
  // follows after a pause, and an address that changed BECAUSE of that write never overrules the
  // box — the write can take a while to land (the frame re-checks the session on every address
  // change) and more keys arrive meanwhile. The address wins only when somebody else changed it:
  // the header's search, a link, back / forward. `null` = the box shows the address.
  const [typed, setTyped] = useState<string | null>(null);
  const [seenQ, setSeenQ] = useState(state.q);
  const ownWrite = navigationType !== "POP" && isOwnWrite(location.state);
  if (state.q !== seenQ) {
    setSeenQ(state.q);
    if (!ownWrite && typed !== null && typed.trim() !== state.q) setTyped(null);
  }
  useEffect(() => {
    if (typed === null) return;
    const q = typed.trim().slice(0, Q_MAX);
    if (q === state.q) return;
    const timer = setTimeout(
      () => setParams(searchParamsOf({ ...state, q }), { replace: true, state: OWN_WRITE }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [typed, state, setParams]);

  const change = (patch: Partial<SearchState>) => {
    const q = typed === null ? state.q : typed.trim().slice(0, Q_MAX);
    setParams(searchParamsOf({ ...state, q, ...patch }));
  };
  const onInputKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown") return;
    const first = listRef.current?.querySelector<HTMLElement>('[data-item-index="0"]');
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const items = useMemo(
    () =>
      (search.data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({
        ...item,
        // An empty hint is no hint: nothing is shown under the name.
        secondary: item.pathHint || undefined,
      })),
    [search.data],
  );
  const searchable = isSearchable(state);
  const count = search.hasNextPage
    ? items.length === 1
      ? t("search.count.more.one")
      : t("search.count.more", { count: items.length })
    : items.length === 1
      ? t("search.count.one")
      : t("search.count", { count: items.length });

  let body;
  if (!searchable) {
    body = <EmptyState type="no-results" title={t("search.prompt.title")} body={t("search.prompt.body")} />;
  } else if (hasFailed(search) || isWaitingOffline(search)) {
    body = <ViewError view="search" title={t("search.error.title")} query={search} />;
  } else {
    body = (
      <>
        <NodeList
          items={items}
          ariaLabel={t("search.results")}
          loading={search.isPending || search.isFetchingNextPage}
          hasMore={canLoadMore(search)}
          onLoadMore={loadMore}
          emptyState={
            <EmptyState type="no-results" title={t("search.none.title")} body={t("search.none.body")} />
          }
        />
        <ListNotice view="search" query={search} />
      </>
    );
  }

  return (
    <ViewPage view="search">
      <Box
        role="search"
        aria-label={t("search.input")}
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 3,
          padding: desktop ? "12px 20px" : "4px 16px 12px",
          borderBottom: `1px solid ${hf.hairline}`,
          flex: "none",
        }}
      >
        <TextField
          type="search"
          size="small"
          label={t("search.input")}
          value={typed ?? state.q}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={onInputKey}
          autoComplete="off"
          slotProps={{ htmlInput: { maxLength: Q_MAX, "data-search-input": "" } }}
          sx={{ flex: "1 1 240px", minWidth: 0 }}
        />
        {desktop ? (
          <Filters state={state} onChange={change} />
        ) : (
          <Button
            onClick={() => setSheet(true)}
            aria-haspopup="dialog"
            startIcon={<SlidersHorizontal size={16} aria-hidden="true" />}
            data-search-filters
          >
            {t("search.filters")}
          </Button>
        )}
        <Box
          role="status"
          aria-live="polite"
          className="num"
          data-search-count
          sx={{ flex: "1 0 100%", color: hf.textSecondary, fontSize: 12, minHeight: 16 }}
        >
          {searchable && search.data && !search.isPlaceholderData ? count : ""}
        </Box>
      </Box>
      <Box ref={listRef} sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
        {body}
      </Box>
      {desktop ? null : (
        <BottomSheet open={sheet} onClose={() => setSheet(false)} title={t("search.filters")}>
          <Box sx={{ padding: "0 12px 12px" }}>
            <Filters state={state} onChange={change} fullWidth />
          </Box>
        </BottomSheet>
      )}
    </ViewPage>
  );
}
