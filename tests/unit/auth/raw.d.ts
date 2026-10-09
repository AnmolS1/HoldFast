// Vite's `?raw` suffix: the file's text, inlined when the test is transformed. Lets a Worker
// test read installed sources and this repo's own files without a file system.
declare module "*?raw" {
  const text: string;
  export default text;
}
