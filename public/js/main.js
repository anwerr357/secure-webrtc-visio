// Page flow: login -> lobby (camera preview, pick a room) -> call.
import * as api from "./api.js";
import { Signaling } from "./signaling.js";
import { Call } from "./call.js";

const $ = (id) => document.getElementById(id);

let session = null; // { token, user }
let signaling = null;
let localStream = null;
let call = null;
const tiles = new Map(); // peer id -> tile element

function show(view) {
  for (const v of ["loginView", "lobbyView", "callView"]) $(v).hidden = v !== view;
}

// ---- Login ----

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const action = e.submitter?.dataset.action === "register" ? api.register : api.login;
  try {
    session = await action($("username").value.trim(), $("password").value);
    $("password").value = "";
    await connectSignaling();
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

async function connectSignaling() {
  signaling = new Signaling();
  signaling.on("error", ({ message }) => {
    $("lobbyError").textContent = message;
    console.warn("signaling error:", message);
  });
  signaling.on("closed", ({ reason }) => {
    leaveCall();
    session = null;
    $("whoami").textContent = "";
    $("loginError").textContent = reason ? `Disconnected: ${reason}` : "Disconnected from server";
    show("loginView");
  });
  await signaling.connect(session.token);
  $("whoami").textContent = `Signed in as ${session.user}`;
  show("lobbyView");
}

// ---- Lobby ----

$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("lobbyError").textContent = "";
  try {
    localStream ??= await getLocalMedia();
    const iceServers = await api.getIceServers(session.token);
    call = new Call({
      signaling,
      iceServers,
      relayOnly: $("relayOnly").checked,
      localStream,
      ui: callUi,
    });
    const room = $("roomName").value.trim();
    addTile("local", `You (${session.user})`, localStream, true);
    call.join(room);
    $("roomLabel").textContent = `Room: ${room}`;
    show("callView");
  } catch (err) {
    $("lobbyError").textContent = `${err.name || "Error"}: ${err.message}`;
  }
});

// Camera + mic, falling back to audio only if there is no camera.
async function getLocalMedia() {
  const audio = { echoCancellation: true, noiseSuppression: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    if (err.name !== "NotFoundError") throw err;
    return navigator.mediaDevices.getUserMedia({ audio });
  }
}

// ---- Call view ----

const callUi = {
  addPeer: (id, user) => addTile(id, user, null, false),
  removePeer: (id) => {
    tiles.get(id)?.remove();
    tiles.delete(id);
  },
  peerStream: (id, stream) => {
    const video = tiles.get(id)?.querySelector("video");
    if (video && video.srcObject !== stream) video.srcObject = stream;
  },
  peerState: (id, state) => {
    tiles.get(id)?.setAttribute("data-state", state);
  },
  peerStats: (id, m, level) => {
    const tile = tiles.get(id);
    if (!tile) return;
    const badge = tile.querySelector(".badge");
    badge.textContent = level;
    badge.dataset.level = level;
    tile.dataset.level = level;
    tile.querySelector(".stats").textContent = formatStats(m);
  },
  chat: (user, text) => addChat(user, text),
  screenShareEnded: () => { $("screenBtn").textContent = "Share screen"; },
};

function addTile(id, name, stream, isLocal) {
  const tile = $("tileTemplate").content.firstElementChild.cloneNode(true);
  tile.dataset.peer = id;
  tile.querySelector(".name").textContent = name; // textContent: never parse names as HTML
  const video = tile.querySelector("video");
  if (isLocal) {
    video.muted = true; // never play our own mic back
    tile.classList.add("local");
  }
  if (stream) video.srcObject = stream;
  $("grid").appendChild(tile);
  tiles.set(id, tile);
}

const fmt = (v, digits = 0) => (v == null || Number.isNaN(v) ? "-" : v.toFixed(digits));

function formatStats({ out, in: inb, link }) {
  return [
    `path ${link.candidateType ?? "-"}  RTT ${fmt(link.rttMs)} ms  loss ${fmt(link.lossPct, 1)}%  jitter ${fmt(link.jitterMs)} ms`,
    `send ${out.width ?? "-"}x${out.height ?? "-"} ${fmt(out.fps)}fps ${fmt(out.kbps)} kbps` +
      (out.limitation && out.limitation !== "none" ? ` (limited: ${out.limitation})` : ""),
    `recv ${inb.width ?? "-"}x${inb.height ?? "-"} ${fmt(inb.fps)}fps ${fmt(inb.kbps)} kbps loss ${fmt(inb.lossPct, 1)}%`,
  ].join("\n");
}

function addChat(user, text) {
  const li = document.createElement("li");
  const who = document.createElement("strong");
  who.textContent = `${user}: `;
  li.append(who, document.createTextNode(text));
  $("chatLog").appendChild(li);
  li.scrollIntoView({ block: "end" });
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || !call) return;
  call.sendChat(text);
  addChat(`${session.user} (you)`, text);
  $("chatInput").value = "";
});

$("micBtn").addEventListener("click", () => {
  const on = call.toggleTrack("audio");
  $("micBtn").textContent = on ? "Mute mic" : "Unmute mic";
});

$("camBtn").addEventListener("click", () => {
  const on = call.toggleTrack("video");
  $("camBtn").textContent = on ? "Camera off" : "Camera on";
});

$("screenBtn").addEventListener("click", async () => {
  try {
    if (call.screenTrack) {
      await call.stopScreenShare();
    } else {
      await call.startScreenShare();
      $("screenBtn").textContent = "Stop sharing";
    }
  } catch (err) {
    console.warn("screen share:", err);
  }
});

$("hangupBtn").addEventListener("click", () => {
  leaveCall();
  show("lobbyView");
});

function leaveCall() {
  call?.hangup();
  call = null;
  for (const tile of tiles.values()) tile.remove();
  tiles.clear();
  $("chatLog").replaceChildren();
}
