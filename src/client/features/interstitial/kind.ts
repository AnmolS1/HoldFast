// What kind of dangerous file a name is, for the warning's one sentence.

export type Kind = "program" | "script" | "image" | "settings" | "other";

/** The extension groups of the server's list (services/mime.ts DANGEROUS_EXTS). */
const KINDS: Record<Exclude<Kind, "other">, readonly string[]> = {
  program: ["exe", "msi", "pkg", "scr", "com", "jar", "apk", "ipa", "deb", "rpm", "xpi", "crx"],
  script: ["bat", "cmd", "ps1", "sh", "vbs", "js", "jse", "wsf", "hta"],
  image: ["dmg", "iso", "img"],
  settings: ["lnk", "reg", "chm"],
};

/** The kind of a file by its last extension; a name that hides its extension is "other". */
export function dangerKind(fileName: string): Kind {
  const cleaned = fileName.replace(/[. ]+$/, "");
  const dot = cleaned.lastIndexOf(".");
  const ext = dot <= 0 ? "" : cleaned.slice(dot + 1).toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS) as Array<[Exclude<Kind, "other">, readonly string[]]>) {
    if (exts.includes(ext)) return kind;
  }
  return "other";
}
