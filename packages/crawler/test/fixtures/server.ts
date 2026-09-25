import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

export const SITE_DIR = fileURLToPath(new URL("./site/", import.meta.url));

export interface LoggedRequest {
  readonly path: string;
  readonly userAgent: string | undefined;
  readonly at: number;
}

export interface FixtureServer {
  readonly origin: string;
  readonly requests: LoggedRequest[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

/** 1×1 transparent PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Exact, case-sensitive map of URL path → file (the host file system may be case-insensitive). */
function indexFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set("/" + relative(dir, full).split(sep).join("/"), full);
    }
  };
  walk(dir);
  return files;
}

const REDIRECTS: Record<string, [number, string]> = {
  "/old-page": [301, "/moved.html"],
  "/chain-a": [302, "/chain-b"],
  "/chain-b": [301, "/about.html"],
  "/loop-a": [302, "/loop-b"],
  "/loop-b": [302, "/loop-a"],
  "/to-external": [301, "https://external.invalid/"],
  "/to-private": [301, "/private/secret.html"],
  "/blog": [301, "/blog/"],
};

/**
 * Static server for the fixture site plus dynamic routes:
 * redirects (above), /flaky (503 once, then 200), /always-500, /slow (responds after `slowMs`),
 * /image.png. Paths are matched exactly and case-sensitively; unknown paths are 404.
 */
export async function startFixtureServer(opts: { slowMs?: number } = {}): Promise<FixtureServer> {
  const files = indexFiles(SITE_DIR);
  const requests: LoggedRequest[] = [];
  let flakyHits = 0;
  const slowMs = opts.slowMs ?? 2_000;

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const html = (title: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const path = url.pathname;
    requests.push({
      path: path + url.search,
      userAgent: req.headers["user-agent"],
      at: Date.now(),
    });

    const redirect = REDIRECTS[path];
    if (redirect !== undefined) {
      res.writeHead(redirect[0], { location: redirect[1] });
      res.end();
      return;
    }
    switch (path) {
      case "/flaky":
        flakyHits += 1;
        if (flakyHits === 1) send(res, 503, "text/plain", "try again");
        else send(res, 200, TYPES[".html"] as string, html("Flaky recovered"));
        return;
      case "/always-500":
        send(res, 500, "text/plain", "broken");
        return;
      case "/slow": {
        const timer = setTimeout(
          () => send(res, 200, TYPES[".html"] as string, html("Slow")),
          slowMs,
        );
        res.on("close", () => clearTimeout(timer));
        return;
      }
      case "/image.png":
        send(res, 200, "image/png", PNG);
        return;
    }
    const file = files.get(path.endsWith("/") ? `${path}index.html` : path);
    if (file === undefined) {
      send(res, 404, "text/plain", "not found");
      return;
    }
    const ext = file.slice(file.lastIndexOf("."));
    send(res, 200, TYPES[ext] ?? "application/octet-stream", readFileSync(file));
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
