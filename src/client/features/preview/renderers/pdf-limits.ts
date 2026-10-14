// The bounds of the PDF viewer: how many pages, and how many canvas pixels a page may take.

/** Pages shown at most; the rest is the download's. */
export const PDF_MAX_PAGES = 500;

/** Canvas pixels per page at most: a huge page is drawn less sharply, not refused. */
export const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Canvas pixels per CSS pixel: the screen's, at most 2 — and as little as it takes to keep the
 * canvas under the pixel cap. There is no floor: a 20,000-point page is drawn coarsely, never
 * given a canvas of its own size.
 */
export function pixelRatioFor(width: number, height: number, device: number): number {
  const wanted = Math.min(device > 0 ? device : 1, 2);
  const most = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return Math.min(wanted, most);
}

/** Text runs per page given a selectable layer; a page with more is drawn without one. */
export const TEXT_LAYER_MAX_ITEMS = 20_000;

/** Links per page turned into buttons. */
export const PAGE_MAX_LINKS = 500;

/** Pixels (width × height) of one embedded image pdf.js will decode; larger ones are left out. */
export const PDF_MAX_IMAGE_PIXELS = 64_000_000;

/** Pages being drawn at any moment. */
export const PDF_MAX_CONCURRENT_RENDERS = 2;

/** Pixels of all canvases alive at once (4 bytes each): pages beyond it wait for one to leave. */
export const PDF_LIVE_CANVAS_MAX_PIXELS = 64_000_000;

export interface RenderSlot {
  /** Resolves true when the page may be drawn; false when the slot was released first. */
  granted: Promise<boolean>;
  /** Drawing is over (the canvas, and so its pixels, stay). */
  finished(): void;
  /** The page came into, or left, the visible part of the window. */
  setVisible(visible: boolean): void;
  /** The canvas is gone, or the page gave up waiting. */
  release(): void;
}

export interface RenderRequest {
  /** On screen now (not merely near): served before pages nobody sees. */
  visible?: boolean;
  /**
   * Called when this page's finished canvas is taken back to make room for a visible page. The
   * page drops its canvas and may ask again.
   */
  onEvict?: () => void;
}

export interface RenderBudget {
  request(pixels: number, options?: RenderRequest): RenderSlot;
  /** For tests: what is being drawn, alive and waiting right now. */
  stats(): { rendering: number; pixels: number; waiting: number };
}

/**
 * Who may draw now. At most `maxRenders` pages are drawn at a time, and a page starts only while
 * the canvases already alive, plus its own, stay under `maxPixels` — except that one page is
 * always allowed (a single page is already capped by `MAX_CANVAS_PIXELS`). A page that is VISIBLE
 * goes before pages that are only near, and when the pixels are held by finished pages nobody
 * sees, those give theirs back to it. Otherwise first come, first served.
 */
export function createRenderBudget(
  maxRenders = PDF_MAX_CONCURRENT_RENDERS,
  maxPixels = PDF_LIVE_CANVAS_MAX_PIXELS,
): RenderBudget {
  interface Entry {
    pixels: number;
    visible: boolean;
    state: "waiting" | "rendering" | "alive" | "gone";
    grant(ok: boolean): void;
    onEvict: (() => void) | undefined;
  }
  const queue: Entry[] = [];
  const live = new Set<Entry>();
  const rendering = () => Array.from(live).filter((entry) => entry.state === "rendering").length;
  const pixels = () => Array.from(live).reduce((sum, entry) => sum + entry.pixels, 0);
  const fits = (entry: Entry) => live.size === 0 || pixels() + entry.pixels <= maxPixels;
  const pump = () => {
    while (queue.length > 0) {
      if (rendering() >= maxRenders) return;
      const next = queue.find((entry) => entry.visible) ?? queue[0]!;
      if (!fits(next) && next.visible) {
        // Finished pages that are not on screen make room for one that is.
        for (const holder of Array.from(live)) {
          if (fits(next)) break;
          if (holder.state !== "alive" || holder.visible) continue;
          holder.state = "gone";
          live.delete(holder);
          holder.onEvict?.();
        }
      }
      if (!fits(next)) return;
      queue.splice(queue.indexOf(next), 1);
      next.state = "rendering";
      live.add(next);
      next.grant(true);
    }
  };
  return {
    request(wanted, options = {}) {
      let grant!: (ok: boolean) => void;
      const granted = new Promise<boolean>((resolve) => {
        grant = resolve;
      });
      const entry: Entry = {
        pixels: Math.max(0, wanted),
        visible: options.visible === true,
        state: "waiting",
        grant,
        onEvict: options.onEvict,
      };
      queue.push(entry);
      pump();
      return {
        granted,
        finished() {
          if (entry.state !== "rendering") return;
          entry.state = "alive";
          pump();
        },
        setVisible(visible) {
          entry.visible = visible;
          if (entry.state !== "gone") pump();
        },
        release() {
          if (entry.state === "gone") return;
          if (entry.state === "waiting") {
            queue.splice(queue.indexOf(entry), 1);
            entry.grant(false);
          }
          entry.state = "gone";
          live.delete(entry);
          pump();
        },
      };
    },
    stats: () => ({ rendering: rendering(), pixels: pixels(), waiting: queue.length }),
  };
}
