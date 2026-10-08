// Proves the node project runs in plain Node, and pins the harness's own derivations.
import { afterEach, describe, expect, it } from "vitest";
import { appOrigin, e2ePort, filesOrigin, localDbName, localDbUrl } from "../../../setup/local-env";

const saved = { ...process.env };
afterEach(() => {
  for (const name of ["HOLDFAST_DB", "HOLDFAST_PORT", "HOLDFAST_E2E_PORT"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("node project", () => {
  it("runs in Node, without a DOM", () => {
    expect(typeof process.versions.node).toBe("string");
    expect(typeof window).toBe("undefined");
  });

  it("never loads .env into a local Worker", () => {
    expect(process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe("false");
  });
});

describe("local-env", () => {
  it("derives the local connection string from HOLDFAST_DB alone", () => {
    delete process.env.HOLDFAST_DB;
    expect(localDbUrl()).toBe("postgres://postgres:postgres@localhost:5432/holdfast");
    process.env.HOLDFAST_DB = "holdfast_t05";
    expect(localDbUrl()).toBe("postgres://postgres:postgres@localhost:5432/holdfast_t05");
  });

  it.each(["neondb", "holdfast-t05", "holdfast_T05", 'holdfast"; drop', "holdfast_x@neon.tech/neondb"])(
    "rejects the database name %s",
    (name) => {
      process.env.HOLDFAST_DB = name;
      expect(() => localDbName()).toThrow(/HOLDFAST_DB/);
    },
  );

  it("uses one port: HOLDFAST_PORT, with HOLDFAST_E2E_PORT as an alias", () => {
    delete process.env.HOLDFAST_PORT;
    delete process.env.HOLDFAST_E2E_PORT;
    expect(e2ePort()).toBe(5173);
    process.env.HOLDFAST_PORT = "5184";
    expect(e2ePort()).toBe(5184);
    process.env.HOLDFAST_E2E_PORT = "5185";
    expect(e2ePort()).toBe(5185);
    process.env.HOLDFAST_PORT = "eighty";
    delete process.env.HOLDFAST_E2E_PORT;
    expect(() => e2ePort()).toThrow(/HOLDFAST_PORT/);
  });

  it("builds both origins for a port", () => {
    expect(appOrigin(5184)).toBe("http://localhost:5184");
    expect(filesOrigin(5184)).toBe("http://files.localhost:5184");
  });
});
