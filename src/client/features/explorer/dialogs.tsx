// The explorer's two dialogs: a name (new folder, rename) and the folder-tree picker of "Move to…".
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { NodeName } from "../../../shared/schemas/common";
import type { NodeDto } from "../../../shared/schemas/node";
import { FolderGlyph } from "../../components/FileBadge";
import { t as shellT } from "../../lib/i18n";
import { hf, layout } from "../../theme/tokens";
import type { MoveTarget } from "./actions";
import { explorerKeys, fetchFolders } from "./queries";
import { t } from "./strings";

export interface NameDialogProps {
  open: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  initial: string;
  /** Select the name without its extension, so typing replaces only the name. */
  selectStem?: boolean;
  busy?: boolean;
  /** A refusal from the server, shown under the field. */
  error?: string | null;
  onSubmit(name: string): void;
  onCancel(): void;
}

function NameForm(props: Omit<NameDialogProps, "open" | "title">) {
  const { label, confirmLabel, initial, selectStem, busy, error, onSubmit, onCancel } = props;
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus from an effect, not `autoFocus`: the dialog's focus trap is an effect too.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = selectStem ? initial.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  const name = value.trim();
  const problem =
    name === ""
      ? t("explorer.name.empty")
      : !NodeName.safeParse(name).success
        ? t("explorer.name.tooLong")
        : null;
  const shown = touched ? (problem ?? error ?? null) : (error ?? null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || busy) return;
    onSubmit(name);
  };
  return (
    <Box component="form" onSubmit={submit} noValidate>
      <DialogContent>
        <TextField
          fullWidth
          margin="dense"
          label={label}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          error={shown !== null}
          helperText={shown ?? " "}
          autoComplete="off"
          inputRef={inputRef}
          slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: "off", maxLength: 255 } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          {shellT("app.cancel")}
        </Button>
        <Button type="submit" variant="contained" disabled={busy}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Box>
  );
}

/** One text field: the name of a new folder, or a new name for a file or folder. */
export function NameDialog({ open, title, onCancel, busy, ...form }: NameDialogProps) {
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      aria-labelledby={titleId}
      maxWidth="xs"
      fullWidth
      data-name-dialog
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <NameForm {...form} busy={busy} onCancel={onCancel} />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------

export interface MoveDialogProps {
  open: boolean;
  /** What is being moved. A folder among them cannot be opened or chosen. */
  nodes: readonly NodeDto[];
  /** The top of the tree the caller may move within: their own top level, or a share root. */
  root: MoveTarget;
  onMove(target: MoveTarget): void;
  onCancel(): void;
}

interface TreeState {
  expanded: ReadonlySet<string>;
  chosen: MoveTarget | null;
  focus: string;
}

const keyOf = (id: string | null) => id ?? "top";

function TreeItem({
  folder,
  level,
  moving,
  state,
  setState,
}: {
  folder: MoveTarget;
  level: number;
  moving: ReadonlySet<string>;
  state: TreeState;
  setState(next: TreeState): void;
}) {
  const key = keyOf(folder.id);
  const blocked = folder.id !== null && moving.has(folder.id);
  const open = state.expanded.has(key) && !blocked;
  const children = useQuery({
    queryKey: explorerKeys.folders(folder.id),
    queryFn: ({ signal }) => fetchFolders(folder.id, signal),
    enabled: open,
  });
  const selected = state.chosen !== null && keyOf(state.chosen.id) === key;
  const toggle = (expand: boolean) => {
    const expanded = new Set(state.expanded);
    if (expand) expanded.add(key);
    else expanded.delete(key);
    setState({ ...state, expanded, focus: key });
  };
  const choose = () => {
    if (!blocked) setState({ ...state, chosen: folder, focus: key });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const items = Array.from(
      event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );
    const at = items.indexOf(event.currentTarget);
    const go = (index: number) => items[Math.min(items.length - 1, Math.max(0, index))]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        go(at + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        go(at - 1);
        return;
      case "Home":
        event.preventDefault();
        go(0);
        return;
      case "End":
        event.preventDefault();
        go(items.length - 1);
        return;
      case "ArrowRight":
        event.preventDefault();
        if (blocked) return;
        if (!open) toggle(true);
        else go(at + 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (open) toggle(false);
        else event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose();
        return;
    }
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Box
      component="li"
      role="treeitem"
      aria-level={level}
      aria-expanded={blocked ? undefined : open}
      aria-selected={selected}
      aria-disabled={blocked || undefined}
      aria-label={folder.name}
      tabIndex={state.focus === key ? 0 : -1}
      data-tree-item={key}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && state.focus !== key) setState({ ...state, focus: key });
      }}
      sx={{ listStyle: "none", outlineOffset: -2, borderRadius: `${layout.radius.control}px` }}
    >
      <Box
        onClick={choose}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          minHeight: "var(--hf-row-h)",
          paddingLeft: `${(level - 1) * 16 + 4}px`,
          paddingRight: 2,
          borderRadius: `${layout.radius.control}px`,
          cursor: blocked ? "not-allowed" : "default",
          color: blocked ? hf.textSecondary : hf.text,
          backgroundColor: selected ? hf.navActive : "transparent",
          fontWeight: selected ? 500 : 400,
          "&:hover": { backgroundColor: selected ? hf.navActive : hf.surface2 },
        }}
      >
        <Box
          component="span"
          aria-hidden="true"
          onClick={(event) => {
            event.stopPropagation();
            if (!blocked) toggle(!open);
          }}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: "var(--hf-row-h)",
            flex: "none",
            color: hf.textSecondary,
            visibility: blocked ? "hidden" : "visible",
          }}
        >
          <Chevron size={14} />
        </Box>
        <FolderGlyph size={16} />
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {folder.name}
        </Box>
      </Box>
      {open ? (
        <Box component="ul" role="group" sx={{ margin: 0, padding: 0 }}>
          {children.isPending ? (
            <Box component="li" role="none" sx={{ ...noteSx, paddingLeft: `${level * 16 + 32}px` }}>
              {shellT("app.loading")}
            </Box>
          ) : children.isError ? (
            <Box component="li" role="none" sx={{ ...noteSx, paddingLeft: `${level * 16 + 32}px` }}>
              {t("explorer.move.loadFailed")}
            </Box>
          ) : children.data.length === 0 ? (
            <Box component="li" role="none" sx={{ ...noteSx, paddingLeft: `${level * 16 + 32}px` }}>
              {t("explorer.move.noFolders")}
            </Box>
          ) : (
            children.data.map((child) => (
              <TreeItem
                key={child.id}
                folder={{ id: child.id, name: child.name }}
                level={level + 1}
                moving={moving}
                state={state}
                setState={setState}
              />
            ))
          )}
        </Box>
      ) : null}
    </Box>
  );
}

const noteSx = {
  listStyle: "none",
  display: "flex",
  alignItems: "center",
  minHeight: "var(--hf-row-h)",
  color: hf.textSecondary,
  fontSize: 12,
} as const;

function MoveForm({ nodes, root, onMove, onCancel }: Omit<MoveDialogProps, "open">) {
  const rootKey = keyOf(root.id);
  const [state, setState] = useState<TreeState>({
    expanded: new Set([rootKey]),
    chosen: null,
    focus: rootKey,
  });
  const treeRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    treeRef.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
  }, []);
  const moving = new Set(nodes.map((node) => node.id));
  // Moving something to where it already is changes nothing.
  const sameParent = state.chosen !== null && nodes.every((node) => node.parentId === state.chosen!.id);
  return (
    <>
      <DialogContent>
        <Box
          component="ul"
          role="tree"
          ref={treeRef}
          aria-label={t("explorer.move.tree")}
          data-move-tree
          sx={{
            margin: 0,
            padding: 1,
            height: 280,
            overflowY: "auto",
            border: `1px solid ${hf.hairline}`,
            borderRadius: `${layout.radius.control}px`,
          }}
        >
          <TreeItem folder={root} level={1} moving={moving} state={state} setState={setState} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{shellT("app.cancel")}</Button>
        <Button
          variant="contained"
          disabled={state.chosen === null || sameParent}
          onClick={() => state.chosen && onMove(state.chosen)}
          data-move-confirm
        >
          {t("explorer.move.confirm")}
        </Button>
      </DialogActions>
    </>
  );
}

/** "Move to…": choose a folder from a tree that loads one level at a time. */
export function MoveDialog({ open, onCancel, ...form }: MoveDialogProps) {
  const titleId = useId();
  const count = form.nodes.length;
  return (
    <Dialog open={open} onClose={onCancel} aria-labelledby={titleId} maxWidth="xs" fullWidth data-move-dialog>
      <DialogTitle id={titleId}>
        {count === 1
          ? t("explorer.move.titleOne", { name: form.nodes[0]!.name })
          : t("explorer.move.titleMany", { count })}
      </DialogTitle>
      <MoveForm {...form} onCancel={onCancel} />
    </Dialog>
  );
}
