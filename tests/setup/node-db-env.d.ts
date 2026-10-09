// `Env` for Node-run code that imports the Worker's database layer (tsconfig.tests.db.json): the
// tests under tests/unit/db and the scripts listed in that project. Under Node there is no Worker
// environment, only a stub built from a connection string, so this `Env` has the one binding the
// database layer reads. Code that needs any other binding belongs in the Workers test project.
//
// The type is imported from the package's module build: the global build would replace Node's
// own `URL`, `fetch` and friends in this project.
import type { Hyperdrive } from "@cloudflare/workers-types/index.ts";

declare global {
  interface Env {
    HYPERDRIVE: Hyperdrive;
  }
}
