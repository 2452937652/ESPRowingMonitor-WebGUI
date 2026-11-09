import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const directory = "dist/esp-rowing-monitor-client/browser";
const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg",
    ".ico": "image/x-icon", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain" };
const assets = {};
async function collect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await collect(full);
        else {
            if (entry.name.endsWith(".map") || entry.name === "stats.json") continue;
            const content = await readFile(full);
            const name = "/" + relative(directory, full).replaceAll("\\", "/");
            assets[name] = [types[extname(name)] ?? "application/octet-stream",
                gzipSync(content, { level: 9 }).toString("base64"),
                createHash("sha256").update(content).digest("hex").slice(0, 24)];
        }
    }
}
await collect(directory);
const build = { version: "2.0.0", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
const code = `// Generated from the production build; edit tools/package-worker.mjs instead.
const ASSETS = Object.freeze(${JSON.stringify(assets)});
const BUILD = Object.freeze(${JSON.stringify(build)});
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
    if (url.pathname === '/__version') return Response.json(BUILD,{headers:{'Cache-Control':'no-store'}});
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad request',{status:400}); }
    let key = pathname === '/' ? '/index.html' : pathname;
    if (!Object.hasOwn(ASSETS,key) && !/\\.[^/]+$/.test(key) && (request.headers.get('accept')||'').includes('text/html')) key='/index.html';
    if (!Object.hasOwn(ASSETS,key)) return new Response('Not found',{status:404});
    const [type,data,hash] = ASSETS[key];
    const match = /(?:^|,)\\s*gzip\\s*(?:;\\s*q=(0(?:\\.\\d+)?|1(?:\\.0*)?))?\\s*(?:,|$)/i.exec(request.headers.get('accept-encoding')||'');
    const encoded = !!match && Number(match[1] ?? 1) > 0;
    const headers = new Headers({'Content-Type':type,'X-Content-Type-Options':'nosniff',
      'Cache-Control':/-[A-Z0-9]{8}\\.(?:js|css)$/.test(key)?'public,max-age=31536000,immutable':'no-cache',
      'ETag':'W/"'+hash+'"','Vary':'Accept-Encoding','X-Rowing-Version':'2.0.0'});
    if (request.headers.get('if-none-match')===headers.get('ETag')) return new Response(null,{status:304,headers});
    if (encoded) headers.set('Content-Encoding','gzip');
    if (request.method==='HEAD') return new Response(null,{headers,encodeBody:'manual'});
    const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
    const body=encoded?bytes:new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(body,{headers,encodeBody:'manual'});
  }
};
`;
await mkdir("deploy/generated", { recursive: true });
await writeFile("deploy/generated/worker.mjs", code);
console.log(JSON.stringify({ files: Object.keys(assets).length, scriptBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).byteLength, build }));
