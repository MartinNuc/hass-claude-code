/// <reference types="bun-types" />
import { spawn } from "child_process";

// Web terminal server — uses Bun's HTTP/WebSocket with Node.js child_process for PTY.
// Avoids Bun.openpty() (experimental) and native node-pty (requires build tools).
// The PTY is provided by `script -q /dev/null bash` which is part of Alpine's util-linux.

const INGRESS_PATH = Bun.env.HASSIO_INGRESS_PATH ?? "";

const xtermJs  = Bun.file("/app/assets/xterm.js");
const xtermCss = Bun.file("/app/assets/xterm.css");
const fitJs    = Bun.file("/app/assets/addon-fit.js");

// All asset paths are relative — HA strips the ingress prefix before forwarding
// to the add-on, so relative URLs resolve correctly without knowing the token.
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
    term.open(document.getElementById('terminal'));
    fit.fit();
    window.addEventListener('resize', () => fit.fit());

    // Derive WebSocket URL from the page location — works regardless of ingress path.
    const loc  = window.location;
    const base = loc.pathname.endsWith('/') ? loc.pathname : loc.pathname + '/';
    const ws   = new WebSocket(
      (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + base + 'ws'
    );
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = e => term.write(new Uint8Array(e.data));
    term.onData(d => { if (ws.readyState === 1) ws.send(d); });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
  </script>
</body>
</html>`;

interface Session {
  proc: ReturnType<typeof spawn>;
}

Bun.serve<Session>({
  port: 7681,

  fetch(req, server) {
    // HA ingress strips the token prefix before forwarding — we always see clean paths.
    const path = new URL(req.url).pathname;

    if (path === "/ws") { server.upgrade(req); return; }
    if (path === "/xterm.js")     return new Response(xtermJs,  { headers: { "content-type": "application/javascript" } });
    if (path === "/xterm.css")    return new Response(xtermCss, { headers: { "content-type": "text/css" } });
    if (path === "/addon-fit.js") return new Response(fitJs,    { headers: { "content-type": "application/javascript" } });

    return new Response(HTML, { headers: { "content-type": "text/html" } });
  },

  websocket: {
    open(ws) {
      // `script -q /dev/null bash` allocates a real PTY via util-linux's script command.
      // This gives bash full readline/prompt support without needing node-pty or Bun.openpty().
      const proc = spawn("script", ["-q", "/dev/null", "bash"], {
        env: {
          ...process.env,
          TERM:  "xterm-256color",
          HOME:  "/root",
          SHELL: "/bin/bash",
        },
        // script allocates its own PTY; we talk to it via stdin/stdout pipes
      });

      ws.data = { proc };

      proc.stdout.on("data", (chunk: Buffer) => {
        ws.sendBinary(new Uint8Array(chunk));
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        ws.sendBinary(new Uint8Array(chunk));
      });
      proc.on("close", () => ws.close());
    },

    message(ws, msg) {
      if (typeof msg === "string") return; // resize/control — ignore for now
      ws.data.proc.stdin!.write(Buffer.from(msg as ArrayBuffer));
    },

    close(ws) {
      ws.data.proc.kill();
    },
  },
});

console.log(`[terminal] Listening on :7681 (ingress: "${INGRESS_PATH}")`);
