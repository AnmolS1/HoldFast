// Turning what the browser hands over — a drop, a paste, a folder picker — into files with the
// folder path each belongs to.
import type { IncomingFile } from "./manager";
import { lastSegment, MAX_DROP_FILES, parentPath } from "./plan";

export interface Intake {
  files: IncomingFile[];
  /** Every folder path seen, including empty folders. */
  folders: string[];
  /** Paths of entries the browser could not read. They are left out; the rest goes on. */
  unreadable: string[];
  /** The drop holds more files than one upload takes: the walk stopped. */
  tooMany: boolean;
  /** System files a folder carried (`isSystemClutter`): left out, and the user is told how many. */
  skipped: number;
}

/** What an operating system writes into folders on its own; never a name the user gave. */
const CLUTTER_NAMES = new Set([".DS_Store", "Thumbs.db", "ehthumbs.db", "desktop.ini", "Icon\r"]);

/**
 * A file the operating system put there, not the user: Finder's `.DS_Store`, a custom-icon `Icon\r`
 * and AppleDouble `._` files, Windows' thumbnail caches and `desktop.ini`, and anything inside a
 * `__MACOSX` folder. Other dotfiles (`.env`, `.gitignore`, `.git/…`) are the user's data. Asked only
 * of files that came inside a folder: a file the user chose on its own is uploaded whatever its
 * name. Convenience, not a control — the server takes a `.DS_Store` like any file.
 */
export function isSystemClutter(name: string, pathSegments: readonly string[]): boolean {
  return CLUTTER_NAMES.has(name) || name.startsWith("._") || pathSegments.includes("__MACOSX");
}

const segments = (path: string) => (path ? path.split("/") : []);

/**
 * A folder picker that handed back files without a folder path: the browser picked files, not a
 * folder (the property can exist while the system's picker returns plain files). Never uploaded
 * flat into the target.
 */
export function folderPickWasFlat(files: readonly File[]): boolean {
  return files.length > 0 && files.every((file) => !file.webkitRelativePath);
}

/** Does the drag carry files from the operating system (and not text or a dragged row)? */
export function carriesFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types).includes("Files"));
}

/** The files of a `webkitdirectory` picker (or a plain one): the path comes with each file. */
export function fromFileList(list: Iterable<File>): Intake {
  const files: IncomingFile[] = [];
  const folders = new Set<string>();
  let skipped = 0;
  for (const file of list) {
    const path = parentPath(file.webkitRelativePath ?? "");
    // A folder that held only clutter is still made: it is a folder the user chose.
    if (path && !segments(path).includes("__MACOSX")) folders.add(path);
    if (path && isSystemClutter(file.name, segments(path))) skipped += 1;
    else files.push({ file, path });
  }
  return {
    files,
    folders: Array.from(folders),
    unreadable: [],
    tooMany: files.length > MAX_DROP_FILES,
    skipped,
  };
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Walk one entry. Each entry fails on its own: an unreadable file or folder is written down and
 * its siblings are still taken. The walk ends once the drop is larger than one upload takes.
 */
async function walk(entry: FileSystemEntry, into: Intake, wanted: () => boolean): Promise<void> {
  // Not wanted any more (the account that dropped it is gone): nothing further is read.
  if (into.tooMany || !wanted()) return;
  const path = entry.fullPath.replace(/^\/+/, "");
  if (entry.isFile) {
    const folder = parentPath(path);
    // Left out without being read; a file dropped on its own (no folder) is always taken.
    if (folder && isSystemClutter(entry.name ?? lastSegment(path), segments(folder))) {
      into.skipped += 1;
      return;
    }
    try {
      into.files.push({ file: await fileOf(entry as FileSystemFileEntry), path: folder });
      if (into.files.length > MAX_DROP_FILES) into.tooMany = true;
    } catch {
      into.unreadable.push(path);
    }
    return;
  }
  if (!entry.isDirectory) return;
  // Walked only to count what it holds: no folder is made for `__MACOSX` or anything in it.
  if (!segments(path).includes("__MACOSX")) into.folders.push(path);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // A reader hands its entries over in batches; an empty batch is the end.
  for (;;) {
    let batch: FileSystemEntry[];
    try {
      batch = await readBatch(reader);
    } catch {
      // What was read of this folder stays; what could not be listed is named by the folder.
      into.unreadable.push(path);
      return;
    }
    if (batch.length === 0) return;
    for (const child of batch) await walk(child, into, wanted);
  }
}

/**
 * The files and folders of a drop. The entries must be taken while the drop event is still being
 * handled — the transfer is emptied after — so that part is synchronous and only the walk waits.
 * The walk can take seconds; `wanted` is asked before every entry and ends it.
 */
export function fromDrop(transfer: DataTransfer, wanted: () => boolean = () => true): Promise<Intake> {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  if (entries.length === 0 && loose.length === 0) loose.push(...Array.from(transfer.files ?? []));
  return (async () => {
    const intake: Intake = {
      files: loose.map((file) => ({ file, path: "" })),
      folders: [],
      unreadable: [],
      tooMany: false,
      skipped: 0,
    };
    for (const entry of entries) await walk(entry, intake, wanted);
    return intake;
  })();
}
