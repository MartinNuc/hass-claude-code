/// <reference types="bun-types" />

// Web terminal server for Claude Code Agent add-on.
// Uses Bun's native PTY + WebSocket APIs.
// Serves xterm.js from local files (avoids HA ingress CSP restrictions on inline scripts).

const INGRESS_PATH = Bun.env.HASSIO_INGRESS_PATH ?? "";

const xtermJs  = Bun.file("/app/assets/xterm.js");
const xtermCss = Bun.file("/app/assets/xterm.css");
const fitJs    = Bun.file("/app/assets/addon-fit.js");

// HTML uses INGRESS placeholder replaced at serve time so the WebSocket URL
// and asset paths are always correct regardless of the HA ingress token.
const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Code Terminal</title>
  <link rel="stylesheet" href="INGRESS/xterm.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #terminal { height: 100%; background: #1e1e2e; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script src="INGRESS/xterm.js"></script>
  <script src="INGRESS/addon-fit.js"></script>
  <script>
    const term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 14 });
    const fit  = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));
    fit.fit();
    window.addEventListener('resize', () => fit.fit());

    const ws = new WebSocket(
      (location.protocol === 'https:' ? 'wss:' : 'ws:')
      + '//' + location.host + 'INGRESS/ws'
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

interface WsCtx {
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

if (typeof Bun.openpty !== "function") {
  console.error("[terminal] ERROR: Bun.openpty() is not available in this Bun version.");
  console.error("[terminal] Bun version:", Bun.version);
  process.exit(1);
}

Bun.serve<WsCtx>({
  port: 7681,

  fetch(req, server) {
    const url  = new URL(req.url);
    let   path = url.pathname;

    // Strip ingress prefix so paths are relative to add-on root
    if (INGRESS_PATH && path.startsWith(INGRESS_PATH))
      path = path.slice(INGRESS_PATH.length) || "/";

    if (path === "/ws") {
      server.upgrade(req);
      return;
    }
    if (path === "/xterm.js")
      return new Response(xtermJs,  { headers: { "content-type": "application/javascript" } });
    if (path === "/xterm.css")
      return new Response(xtermCss, { headers: { "content-type": "text/css" } });
    if (path === "/addon-fit.js")
      return new Response(fitJs,    { headers: { "content-type": "application/javascript" } });

    const html = HTML_TEMPLATE.replaceAll("INGRESS", INGRESS_PATH);
    return new Response(html, { headers: { "content-type": "text/html" } });
  },

  websocket: {
    async open(ws) {
      const pty = Bun.openpty();

      Bun.spawn(["bash", "-i"], {
        stdin:  pty.slave,
        stdout: pty.slave,
        stderr: pty.slave,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          HOME: "/root",
        },
      });

      const writer = pty.master.writable.getWriter();
      ws.data = { writer };

      // Stream PTY output → WebSocket client
      (async () => {
        const reader = pty.master.readable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.sendBinary(value);
          }
        } catch { /* PTY closed */ }
        ws.close();
      })();
    },

    message(ws, msg) {
      if (typeof msg === "string") {
        // Control messages (e.g. resize) — ignored for now
        return;
      }
      // Binary = keyboard input → PTY stdin
      ws.data.writer.write(new Uint8Array(msg as ArrayBuffer)).catch(() => {});
    },

    close(ws) {
      ws.data.writer.close().catch(() => {});
    },
  },
});

console.log(`[terminal] Listening on :7681 (ingress: "${INGRESS_PATH}")`);
