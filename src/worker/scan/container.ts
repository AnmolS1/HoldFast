// The scanner container's Durable Object class. A placeholder image (containers/clamav) until the
// real scanner lands; the named export `ScannerContainer` is what wrangler.jsonc binds.

import { Container } from "@cloudflare/containers";

export class ScannerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
}
