// WebSocket signaling server.
//
// WebRTC does not define how two browsers find each other: before media can
// flow they must exchange an SDP offer/answer (codecs, encryption
// fingerprints) and ICE candidates (possible network addresses). This server
// only relays those messages between members of the same room. It never sees
// audio or video: media goes peer to peer (or through TURN), encrypted.
//
// Protocol (JSON messages):
//   client -> server: auth {token} | join {room} | leave
//                     offer|answer|ice {to, data}
//   server -> client: welcome {id, user} | joined {room, peers}
//                     peer-joined {id, user} | peer-left {id}
//                     offer|answer|ice {from, data} | error {message}
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const ROOM_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const MAX_PEERS_PER_ROOM = 6; // mesh: every peer uploads to every other peer
const AUTH_TIMEOUT_MS = 5000;
const RELAY_TYPES = new Set(["offer", "answer", "ice"]);

export function attachSignaling(server, { verifyToken }) {
  // maxPayload: an SDP is a few KB; anything far bigger is abuse.
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
  const rooms = new Map(); // room name -> Map(peer id -> client)

  wss.on("connection", (ws, req) => {
    const client = {
      ws,
      id: crypto.randomUUID(),
      user: null,
      room: null,
      bucket: tokenBucket({ capacity: 40, perSecond: 20 }),
    };
    ws.alive = true;
    log(req, "connected", client.id);

    // The token is sent as the first message rather than in the URL, because
    // URLs end up in proxy and server logs. No valid auth in 5 s -> closed.
    const authTimer = setTimeout(() => ws.close(4001, "Authentication timeout"), AUTH_TIMEOUT_MS);

    ws.on("pong", () => { ws.alive = true; });

    ws.on("message", (raw) => {
      if (!client.bucket()) return send(ws, { type: "error", message: "Rate limit exceeded" });

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, { type: "error", message: "Invalid JSON" });
      }
      if (!msg || typeof msg.type !== "string") {
        return send(ws, { type: "error", message: "Missing type" });
      }

      if (!client.user) {
        if (msg.type !== "auth") return ws.close(4001, "Authenticate first");
        const user = verifyToken(msg.token);
        if (!user) return ws.close(4001, "Invalid token");
        clearTimeout(authTimer);
        client.user = user;
        return send(ws, { type: "welcome", id: client.id, user });
      }

      handle(client, msg);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      leaveRoom(client);
      log(req, "disconnected", client.id);
    });
  });

  function handle(client, msg) {
    if (msg.type === "join") return joinRoom(client, msg.room);
    if (msg.type === "leave") return leaveRoom(client);

    if (RELAY_TYPES.has(msg.type)) {
      // A peer may only talk to peers in its own room: you cannot inject an
      // offer into somebody else's call by guessing their id.
      const target = client.room && rooms.get(client.room)?.get(msg.to);
      if (!target) return send(client.ws, { type: "error", message: "Unknown peer" });
      if (!msg.data || typeof msg.data !== "object") {
        return send(client.ws, { type: "error", message: "Missing data" });
      }
      return send(target.ws, { type: msg.type, from: client.id, data: msg.data });
    }

    send(client.ws, { type: "error", message: `Unknown type: ${msg.type}` });
  }

  function joinRoom(client, room) {
    if (typeof room !== "string" || !ROOM_RE.test(room)) {
      return send(client.ws, { type: "error", message: "Room: 1-32 letters, digits, - or _" });
    }
    leaveRoom(client);

    const members = rooms.get(room) ?? new Map();
    if (members.size >= MAX_PEERS_PER_ROOM) {
      return send(client.ws, { type: "error", message: "Room is full" });
    }

    const peers = [...members.values()].map((p) => ({ id: p.id, user: p.user }));
    members.set(client.id, client);
    rooms.set(room, members);
    client.room = room;

    // The newcomer gets the list of existing peers and will send each one an
    // offer. Existing peers only wait for that offer. Having exactly one side
    // start avoids both sides sending offers at the same time ("glare").
    send(client.ws, { type: "joined", room, peers });
    broadcast(members, client.id, { type: "peer-joined", id: client.id, user: client.user });
    console.log(`[room ${room}] ${client.user} joined (${members.size} peers)`);
  }

  function leaveRoom(client) {
    const members = client.room && rooms.get(client.room);
    if (!members) return;
    members.delete(client.id);
    broadcast(members, client.id, { type: "peer-left", id: client.id });
    if (members.size === 0) rooms.delete(client.room);
    console.log(`[room ${client.room}] ${client.user} left`);
    client.room = null;
  }

  // Detect dead connections (laptop closed, network cut) that never send a
  // close frame, so they do not stay in rooms forever.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; // set back to true when the pong arrives
      ws.ping();
    }
  }, 30_000);
  server.on("close", () => clearInterval(heartbeat));

  return wss;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(members, exceptId, msg) {
  for (const [id, peer] of members) if (id !== exceptId) send(peer.ws, msg);
}

// Allows short bursts (capacity) but caps the sustained rate (perSecond).
function tokenBucket({ capacity, perSecond }) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function log(req, event, id) {
  console.log(`[ws] ${event} ${id} from ${req.socket.remoteAddress}`);
}
