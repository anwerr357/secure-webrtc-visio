// Entry point: reads configuration from environment variables and starts.
import crypto from "node:crypto";
import { createServer, loadTls } from "./src/app.js";

const list = (value) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

const config = {
  port: Number(process.env.PORT) || 3000,
  // Without a fixed secret, tokens are signed with a random key and become
  // invalid when the server restarts (users just log in again).
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex"),
  usersFile: process.env.USERS_FILE || "data/users.json",
  stunUrls: list(process.env.STUN_URLS ?? "stun:stun.l.google.com:19302"),
  turnUrls: list(process.env.TURN_URLS),
  turnSecret: process.env.TURN_SECRET,
  tls: loadTls(process.env.CERT_DIR || "certs"),
};

if (!process.env.JWT_SECRET) console.warn("JWT_SECRET not set: using a random one");
if (!config.turnSecret) console.warn("TURN_SECRET not set: STUN only, calls may fail behind strict NATs");

createServer(config).listen(config.port, () => {
  const scheme = config.tls ? "https" : "http";
  console.log(`Server running at ${scheme}://localhost:${config.port}`);
  if (!config.tls) {
    console.log("No certs/ found: plain HTTP works on localhost only. Run `npm run certs` for HTTPS.");
  }
});
