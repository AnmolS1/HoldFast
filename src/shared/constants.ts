// Numbers and names the Worker and the SPA must agree on. Sizes are in BYTES, durations in the
// unit their name says. Frozen with the rest of src/shared (see README-contracts.ts).
//
// Compiled for both the browser and the Worker: no runtime-specific imports here.
//
// A value that also exists as a var (`MAX_FILE_BYTES`, `PART_BYTES`) is that var's DEFAULT: the
// runtime value is the var, surfaced to the SPA as `PublicConfig.maxFileBytes` / `.partBytes`.

// ── uploads ─────────────────────────────────────────────────────────────────────────────────

/** The scanner cannot read a file above 2 GB, so the cap is the scannable size. */
export const MAX_FILE_BYTES_DEFAULT = 2_000_000_000;
/** 64 MiB: the only part size v1 issues. A 2,000,000,000-byte file is 30 parts. */
export const PART_BYTES = 67_108_864;
/** The server rejects a part body above this. Equal to the largest size it issues. */
export const MAX_PART_BYTES = 67_108_864;
/** Files up to this size use one PUT. */
export const SINGLE_PUT_MAX = 67_108_864;
/** The object store's minimum for every part but the last. */
export const MIN_PART_BYTES = 5_242_880;
export const MAX_PARTS = 10_000;
/** Open upload sessions per uploader. */
export const MAX_OPEN_UPLOADS = 20;
export const AVATAR_MAX_BYTES = 5_000_000;

// ── thumbnails and previews ─────────────────────────────────────────────────────────────────

/** Grid 160 and 320, preview 1280. */
export const THUMB_SIZES = [160, 320, 1280] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];
/** Larger images get no thumbnail: the type icon is shown. */
export const THUMB_INPUT_MAX_BYTES = 20_000_000;
/** Largest text or code file the text viewer fetches. */
export const PREVIEW_TEXT_MAX_BYTES = 2_000_000;

// ── zip ─────────────────────────────────────────────────────────────────────────────────────

/** Download URLs minted per call: the window just ahead of the zip stream. */
export const ZIP_URL_BATCH = 50;
export const ZIP_MAX_ENTRIES = 10_000;

// ── tokens and links ────────────────────────────────────────────────────────────────────────

/** Lifetimes of files-host tokens, in seconds. `zip` is a `download` token minted for a zip. */
export const TOKEN_TTL = { download: 300, inline: 900, thumb: 600, scan: 900, zip: 900 } as const;
/** Random bytes in a public link token (base64url in the URL). */
export const LINK_TOKEN_BYTES = 16;
/** Wrong link passwords that carry no delay. */
export const PASSWORD_FREE_ATTEMPTS = 3;
/** The longest delay after a wrong link password, in seconds. */
export const PASSWORD_LOCK_MAX_SEC = 900;

// ── moderation and retention ────────────────────────────────────────────────────────────────

export const STRIKES_TO_SUSPEND = 3;
export const STRIKE_WINDOW_DAYS = 365;
export const TRASH_RETENTION_DAYS = 30;
export const VERSION_RETENTION_DAYS = 30;
/** A scan claimed longer ago than this is taken over by the next delivery. */
export const SCAN_CLAIM_STALE_MINUTES = 20;

// ── headers ─────────────────────────────────────────────────────────────────────────────────

export const HEADER_WARNING = "X-Holdfast-Warning";
export const HEADER_LINK_SESSION = "X-Holdfast-Link-Session";

// ── file categories ─────────────────────────────────────────────────────────────────────────

/**
 * The one category vocabulary: search filters, `NodeDto.mimeCategory`, badges and the preview
 * renderers all use these eight keys. `types` are detected types exactly as the detector spells
 * them (`audio/x-m4a`, not `audio/mp4`, for an .m4a); `exts` are lower-case, without the dot,
 * and are used only when no specific type was detected.
 *
 * A category is a label. It never decides how a file is served: that is the Worker's MIME
 * policy, which refuses SVG, HTML and XML whatever category they show under.
 */
export const MIME_CATEGORIES = {
  image: {
    types: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/bmp",
      "image/heic",
      "image/heif",
      "image/heic-sequence",
      "image/heif-sequence",
      "image/tiff",
      "image/x-icon",
      "image/jxl",
      "image/vnd.adobe.photoshop",
      "image/svg+xml",
    ],
    exts: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "avif",
      "bmp",
      "heic",
      "heif",
      "tif",
      "tiff",
      "ico",
      "jxl",
      "psd",
      "svg",
    ],
  },
  video: {
    types: [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-m4v",
      "video/matroska",
      "video/x-matroska",
      "video/vnd.avi",
      "video/mpeg",
      "video/ogg",
      "video/3gpp",
      "video/mp2t",
      "video/x-flv",
    ],
    exts: ["mp4", "webm", "mov", "m4v", "mkv", "avi", "mpg", "mpeg", "ogv", "3gp", "flv"],
  },
  audio: {
    types: [
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/flac",
      "audio/mp4",
      "audio/x-m4a",
      "audio/aac",
      "audio/aiff",
      "audio/midi",
      "audio/amr",
      "audio/opus",
    ],
    exts: ["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac", "aif", "aiff", "mid", "midi", "amr"],
  },
  pdf: { types: ["application/pdf"], exts: ["pdf"] },
  document: {
    types: [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/rtf",
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/x-cfb",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/epub+zip",
    ],
    exts: [
      "txt",
      "md",
      "markdown",
      "csv",
      "tsv",
      "log",
      "rtf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "odt",
      "ods",
      "odp",
      "epub",
      "pages",
      "numbers",
      "key",
    ],
  },
  archive: {
    types: [
      "application/zip",
      "application/x-7z-compressed",
      "application/x-rar-compressed",
      "application/gzip",
      "application/x-tar",
      "application/x-bzip2",
      "application/x-xz",
      "application/zstd",
      "application/x-lzip",
    ],
    exts: ["zip", "7z", "rar", "gz", "tgz", "tar", "bz2", "xz", "zst", "lz"],
  },
  code: {
    types: [
      "text/html",
      "application/xml",
      "text/xml",
      "application/xhtml+xml",
      "application/json",
      "text/javascript",
      "application/javascript",
      "text/css",
    ],
    exts: [
      "html",
      "htm",
      "xhtml",
      "xml",
      "json",
      "jsonc",
      "js",
      "mjs",
      "cjs",
      "jsx",
      "ts",
      "tsx",
      "css",
      "scss",
      "less",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "swift",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "m",
      "php",
      "pl",
      "lua",
      "r",
      "sql",
      "sh",
      "bash",
      "zsh",
      "ps1",
      "bat",
      "yaml",
      "yml",
      "toml",
      "ini",
      "conf",
      "env",
      "vue",
      "svelte",
      "tex",
      "diff",
      "patch",
    ],
  },
  other: { types: [], exts: [] },
} as const satisfies Record<string, { types: readonly string[]; exts: readonly string[] }>;

export type MimeCategoryName = keyof typeof MIME_CATEGORIES;
export const MIME_CATEGORY_NAMES = Object.keys(MIME_CATEGORIES) as [MimeCategoryName, ...MimeCategoryName[]];

// ── ceilings ────────────────────────────────────────────────────────────────────────────────

/**
 * Every key `settings.ceilings` accepts: the limit vars it can override, plus the four sign-up
 * velocity limits (which have no var). Any other key is a validation error.
 */
export const CEILING_KEYS = [
  "CEIL_USER_BYTES_DAY",
  "CEIL_LINK_BYTES_DAY",
  "CEIL_OWNER_LINK_BYTES_DAY",
  "CEIL_LINK_DOWNLOADS_DAY",
  "CEIL_IP_BYTES_DAY",
  "CEIL_UPLOAD_BYTES_DAY",
  "CEIL_UPLOAD_COUNT_DAY",
  "CEIL_EDITOR_UPLOAD_BYTES_DAY",
  "CEIL_TRANSFORMS_DAY",
  "CEIL_SHARES_DAY",
  "CEIL_LINKS_DAY",
  "NEW_ACCOUNT_DAYS",
  "NEW_ACCOUNT_FACTOR",
  "NEW_ACCOUNT_MAX_LINKS",
  "signupIpDay",
  "signupIp24Day",
  "signupAsnDay",
  "signupDomainDay",
] as const;
export type CeilingKey = (typeof CEILING_KEYS)[number];
