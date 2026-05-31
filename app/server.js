"use strict";
// Web terminal server for Claude Code Agent add-on.
// Uses node-pty for a real PTY (bash with prompts, readline, signals)
// and the ws package for WebSocket. Runs under Node.js (not Bun) so
// native node-pty addon loads without compatibility issues.

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const pty  = require("node-pty");

const ASSETS = "/app/assets";

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Code Terminal</title>
  <link rel="stylesheet" href="xterm.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #terminal { height: 100%; background: #1e1e2e; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script src="xterm.js"></script>
  <script src="addon-fit.js"></script>
  <script>
    const term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 14 });
    const fit  = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById("terminal"));
    fit.fit();
    window.addEventListener("resize", () => fit.fit());

    // Derive WebSocket URL from the current page location.
    // Works regardless of the HA ingress token in the path.
    const loc  = window.location;
    const base = loc.pathname.endsWith("/") ? loc.pathname : loc.pathname + "/";
    const ws   = new WebSocket(
      (loc.protocol === "https:" ? "wss:" : "ws:") + "//" + loc.host + base + "ws"
    );

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (e) => term.write(e.data);
    term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];

  const asset = (file, mime) => {
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(path.join(ASSETS, file)).pipe(res);
  };

  if (p.endsWith("/xterm.js")     || p === "/xterm.js")     return asset("xterm.js",     "application/javascript");
  if (p.endsWith("/xterm.css")    || p === "/xterm.css")    return asset("xterm.css",    "text/css");
  if (p.endsWith("/addon-fit.js") || p === "/addon-fit.js") return asset("addon-fit.js", "application/javascript");

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

// Accept WebSocket connections on any path (HA ingress strips the token prefix).
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  const shell = pty.spawn("bash", ["-i"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd:  "/root",
    env:  { ...process.env, HOME: "/root", TERM: "xterm-256color" },
  });

  shell.onData((data) => {
    if (ws.readyState === 1) ws.send(data);
  });

  ws.on("message", (msg) => {
    const str = msg.toString();
    try {
      const obj = JSON.parse(str);
      if (obj.type === "resize" && obj.cols && obj.rows) {
        shell.resize(obj.cols, obj.rows);
        return;
      }
    } catch { /* not JSON — keyboard input */ }
    shell.write(str);
  });

  ws.on("close", () => shell.kill());
  shell.onExit(() => { if (ws.readyState === 1) ws.close(); });
});

server.listen(7681, () => console.log("[terminal] Listening on :7681"));
