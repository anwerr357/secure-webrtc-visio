// Integration tests: real server on a random port, real WebSocket clients.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createServer } from "../src/app.js";

const TURN_SECRET = "test-turn-secret";
let server, base, wsUrl, tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visio-"));
  server = createServer({
    jwtSecret: "test-jwt-secret",
    usersFile: path.join(tmp, "users.json"),
    stunUrls: ["stun:example.org:3478"],
    turnUrls: ["turn:example.org:3478"],
    turnSecret: TURN_SECRET,
  });
  server.listen(0);
  await once(server, "listening");
  base = `http://localhost:${server.address().port}`;
  wsUrl = `ws://localhost:${server.address().port}/ws`;
});

after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p, body) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function account(username) {
  const res = await post("/api/register", { username, password: "password123" });
  assert.equal(res.status, 201);
  return (await res.json()).token;
}

// Opens a socket that queues incoming messages so tests can await them in order.
async function connect() {
  const ws = new WebSocket(wsUrl);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    waiters.length ? waiters.shift()(msg) : queue.push(msg);
  });
  ws.next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  await once(ws, "open");
  return ws;
}

async function authed(username) {
  const ws = await connect();
  ws.send(JSON.stringify({ type: "auth", token: await account(username) }));
  const welcome = await ws.next();
  assert.equal(welcome.type, "welcome");
  ws.id = welcome.id;
  return ws;
}

test("register stores a hash, never the password", async () => {
  await account("hashcheck");
  const stored = fs.readFileSync(path.join(tmp, "users.json"), "utf8");
  assert.ok(!stored.includes("password123"));
  assert.match(stored, /"hash"/);
});

test("login rejects wrong passwords with a generic message", async () => {
  await account("carol");
  const wrong = await post("/api/login", { username: "carol", password: "nope-nope" });
  const unknown = await post("/api/login", { username: "nobody", password: "nope-nope" });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test("/api/ice requires a token and returns HMAC TURN credentials", async () => {
  assert.equal((await fetch(base + "/api/ice")).status, 401);

  const token = await account("dave");
  const res = await fetch(base + "/api/ice", { headers: { Authorization: `Bearer ${token}` } });
  const { iceServers } = await res.json();
  const turn = iceServers.find((s) => s.urls.some((u) => u.startsWith("turn:")));
  const [expiry, user] = turn.username.split(":");
  assert.equal(user, "dave");
  assert.ok(Number(expiry) > Date.now() / 1000);
  const expected = crypto.createHmac("sha1", TURN_SECRET).update(turn.username).digest("base64");
  assert.equal(turn.credential, expected);
});

test("security headers are set", async () => {
  const res = await fetch(base + "/");
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("WebSocket closes on invalid token", async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: "auth", token: "forged.token.value" }));
  const [code] = await once(ws, "close");
  assert.equal(code, 4001);
});

test("WebSocket closes if the first message is not auth", async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: "join", room: "demo" }));
  const [code] = await once(ws, "close");
  assert.equal(code, 4001);
});

test("peers in a room exchange offers; outsiders cannot reach them", async () => {
  const alice = await authed("alice");
  const bob = await authed("bob");
  const eve = await authed("eve");

  alice.send(JSON.stringify({ type: "join", room: "r1" }));
  assert.deepEqual(await alice.next(), { type: "joined", room: "r1", peers: [] });

  bob.send(JSON.stringify({ type: "join", room: "r1" }));
  const joined = await bob.next();
  assert.deepEqual(joined.peers, [{ id: alice.id, user: "alice" }]);
  assert.deepEqual(await alice.next(), { type: "peer-joined", id: bob.id, user: "bob" });

  bob.send(JSON.stringify({ type: "offer", to: alice.id, data: { type: "offer", sdp: "v=0" } }));
  assert.deepEqual(await alice.next(), { type: "offer", from: bob.id, data: { type: "offer", sdp: "v=0" } });

  // Eve is authenticated but not in r1: she cannot inject an offer.
  eve.send(JSON.stringify({ type: "offer", to: alice.id, data: { type: "offer", sdp: "evil" } }));
  assert.deepEqual(await eve.next(), { type: "error", message: "Unknown peer" });

  bob.close();
  assert.deepEqual(await alice.next(), { type: "peer-left", id: bob.id });
  alice.close();
  eve.close();
});

test("invalid room names and unknown types are rejected", async () => {
  const ws = await authed("frank");
  ws.send(JSON.stringify({ type: "join", room: "../../etc" }));
  assert.equal((await ws.next()).type, "error");
  ws.send(JSON.stringify({ type: "hack" }));
  assert.equal((await ws.next()).message, "Unknown type: hack");
  ws.close();
});
