// The file explorer. Other features reach it through its routes — `/` and `/folder/:id` — and
// its zip engine (the account page's "Download everything").
export { routes } from "./routes";
export { startZip } from "./zip";
export type { ZipOutcome, ZipResult } from "./zip";
