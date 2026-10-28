import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the panel harness at http://127.0.0.1:7811/ (or PORT): the page and
 * demo from here, the panel's script from dist/ (run `pnpm run build` first)
 * and its stylesheet from media/.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const port = Number(process.env.PORT ?? 7811);
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".map": "application/json", ".svg": "image/svg+xml" };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let file;
    if (url.pathname.startsWith("/dist/") || url.pathname.startsWith("/media/")) {
      file = path.join(root, url.pathname);
    } else {
      file = path.join(here, url.pathname === "/" ? "panel.html" : url.pathname);
    }
    const allowed = [path.join(root, "dist"), path.join(root, "media"), here];
    if (!allowed.some((dir) => path.resolve(file).startsWith(dir + path.sep)) || !fs.existsSync(file)) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`Worsley panel harness: http://127.0.0.1:${port}/`));
