// Turning what the browser hands over — a drop, a paste, a folder picker — into files with the
// folder path each belongs to.
import type { IncomingFile } from "./manager";
import { MAX_DROP_FILES, parentPath } from "./plan";

export interface Intake {
  files: IncomingFile[];
  /** Every folder path seen, including empty folders. */
  folders: string[];
  /** Paths of entries the browser could not read. They are left out; the rest goes on. */
  unreadable: string[];
  /** The drop holds more files than one upload takes: the walk stopped. */
  tooMany: boolean;
}

/** Does the drag carry files from the operating system (and not text or a dragged row)? */
export function carriesFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types).includes("Files"));
}

/** The files of a `webkitdirectory` picker (or a plain one): the path comes with each file. */
export function fromFileList(list: Iterable<File>): Intake {
  const files: IncomingFile[] = [];
  const folders = new Set<string>();
  for (const file of list) {
    const path = parentPath(file.webkitRelativePath ?? "");
    if (path) folders.add(path);
    files.push({ file, path });
  }
  return { files, folders: Array.from(folders), unreadable: [], tooMany: files.length > MAX_DROP_FILES };
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
async function walk(entry: FileSystemEntry, into: Intake): Promise<void> {
  if (into.tooMany) return;
  const path = entry.fullPath.replace(/^\/+/, "");
  if (entry.isFile) {
    try {
      into.files.push({ file: await fileOf(entry as FileSystemFileEntry), path: parentPath(path) });
      if (into.files.length > MAX_DROP_FILES) into.tooMany = true;
    } catch {
      into.unreadable.push(path);
    }
    return;
  }
  if (!entry.isDirectory) return;
  into.folders.push(path);
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
    for (const child of batch) await walk(child, into);
  }
}

/**
 * The files and folders of a drop. The entries must be taken while the drop event is still being
 * handled — the transfer is emptied after — so that part is synchronous and only the walk waits.
 */
export function fromDrop(transfer: DataTransfer): Promise<Intake> {
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
    };
    for (const entry of entries) await walk(entry, intake);
    return intake;
  })();
}
