// Builds the HTTP(S) server: static client, REST API (auth + ICE servers)
// and the WebSocket signaling endpoint, all on one port.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import express from "express";
import { createAuth } from "./auth.js";
import { attachSignaling } from "./signaling.js";
import { iceServersFor } from "./turn.js";

export function createServer(config) {
  const app = express();
  const auth = createAuth(config);

  app.use(securityHeaders);
  app.use(express.json({ limit: "10kb" }));
  app.use(express.static(path.resolve("public")));

  app.use("/api", auth.router);
  app.get("/api/ice", auth.requireAuth, (req, res) => {
    res.json({ iceServers: iceServersFor(req.user, config) });
  });

  const server = config.tls
    ? https.createServer(config.tls, app)
    : http.createServer(app);
  attachSignaling(server, auth);
  return server;
}

// Loads certs/cert.pem + certs/key.pem if present (see scripts/gen-certs.sh).
export function loadTls(dir) {
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  if (!fs.existsSync(cert) || !fs.existsSync(key)) return null;
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

function securityHeaders(req, res, next) {
  // CSP: only our own scripts/styles may run, so an injected <script> or
  // inline handler (XSS) is blocked by the browser. connect-src allows the
  // WebSocket back to this same host.
  res.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self' wss: ws:",
    "media-src 'self' blob:",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join("; "));
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  // Camera/mic/screen only for our own origin, never for embedded frames.
  res.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
}
