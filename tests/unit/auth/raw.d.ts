// Vite's `?raw` suffix: the file's text, inlined when the test is transformed. Lets a Worker
// test read installed sources and this repo's own files without a file system.
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's `import.meta.glob`, as the source scan in observability.test.ts uses it (eager, raw).
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
}
