// Placeholder scanner container: answers "200 placeholder" on every path. It contains no scanner.
import { createServer } from "node:http";

const port = 8080;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("placeholder\n");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`placeholder scanner listening on :${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
