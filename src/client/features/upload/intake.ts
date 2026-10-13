// Turning what the browser hands over — a drop, a paste, a folder picker — into files with the
// folder path each belongs to.
import type { IncomingFile } from "./manager";
import { parentPath } from "./plan";

export interface Intake {
  files: IncomingFile[];
  /** Every folder path seen, including empty folders. */
  folders: string[];
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
  return { files, folders: Array.from(folders) };
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, into: Intake): Promise<void> {
  const path = entry.fullPath.replace(/^\/+/, "");
  if (entry.isFile) {
    into.files.push({ file: await fileOf(entry as FileSystemFileEntry), path: parentPath(path) });
    return;
  }
  if (!entry.isDirectory) return;
  into.folders.push(path);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // A reader hands its entries over in batches; an empty batch is the end.
  for (;;) {
    const batch = await readBatch(reader);
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
    const intake: Intake = { files: loose.map((file) => ({ file, path: "" })), folders: [] };
    for (const entry of entries) {
      try {
        await walk(entry, intake);
      } catch {
        // An entry that cannot be read is left out; the rest of the drop goes on.
      }
    }
    return intake;
  })();
}
