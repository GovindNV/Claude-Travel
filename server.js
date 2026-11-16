// Minimal local server: static files plus the /api/flights proxy. No dependencies.
// Usage: node server.js            (optionally SERPAPI_KEY=... PORT=8000 node server.js)
const http = require("http");
const fs = require("fs");
const path = require("path");
const flights = require("./api/flights.js");

const ROOT = __dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const PUBLIC = new Set(["/index.html", "/styles.css", "/app.js", "/data.js", "/airports.js"]);

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/flights") {
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
    return flights(req, res);
  }
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!PUBLIC.has(file)) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(path.join(ROOT, file)).pipe(res);
}).listen(process.env.PORT || 8000, () => console.log(`Wayline running at http://localhost:${process.env.PORT || 8000}`));
