// One call = one room. Mesh topology: we keep one RTCPeerConnection per
// remote participant, each carrying our audio/video and a chat DataChannel.
//
// Media security comes with WebRTC itself and cannot be turned off: each
// connection does a DTLS handshake (its certificate fingerprint is in the
// SDP, which only travels over our authenticated WSS channel), then media
// goes as SRTP, i.e. RTP with encrypted payloads.
import { readStats } from "./stats.js";
import { CongestionController, LEVELS } from "./qos.js";

export class Call {
  // ui: callbacks the page implements (addPeer, removePeer, peerStream,
  // peerState, peerStats, chat).
  constructor({ signaling, iceServers, relayOnly, localStream, ui }) {
    this.signaling = signaling;
    this.rtcConfig = { iceServers, iceTransportPolicy: relayOnly ? "relay" : "all" };
    this.localStream = localStream;
    this.cameraTrack = localStream.getVideoTracks()[0] ?? null;
    this.screenTrack = null;
    this.ui = ui;
    this.peers = new Map(); // peer id -> { pc, dc, user, qos, statsState, queue }

    signaling.on("joined", ({ peers }) => peers.forEach((p) => this.addPeer(p, true)));
    signaling.on("peer-joined", (p) => this.addPeer(p, false));
    signaling.on("peer-left", ({ id }) => this.removePeer(id));
    signaling.on("offer", ({ from, data }) => this.onOffer(from, data));
    signaling.on("answer", ({ from, data }) => this.enqueue(from, (pc) => pc.setRemoteDescription(data)));
    signaling.on("ice", ({ from, data }) => this.enqueue(from, (pc) => pc.addIceCandidate(data)));

    this.statsTimer = setInterval(() => this.pollStats(), 1000);
  }

  join(room) {
    this.signaling.send("join", { room });
  }

  // initiator = true when we are the newcomer: we send the offer.
  addPeer({ id, user }, initiator) {
    const pc = new RTCPeerConnection(this.rtcConfig);
    // Messages for one peer are handled strictly in order (an ICE candidate
    // must not be added before the offer it belongs to has been applied).
    const peer = { pc, dc: null, user, qos: new CongestionController(), statsState: {}, queue: Promise.resolve() };
    this.peers.set(id, peer);
    this.ui.addPeer(id, user);

    for (const track of this.localStream.getTracks()) {
      const sending = track.kind === "video" && this.screenTrack ? this.screenTrack : track;
      pc.addTrack(sending, this.localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.send("ice", { to: id, data: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => this.ui.peerStream(id, e.streams[0]);
    pc.onconnectionstatechange = () => {
      this.ui.peerState(id, pc.connectionState);
      if (pc.connectionState === "connected") this.applyLevel(peer);
    };

    if (initiator) {
      this.setupChannel(peer, pc.createDataChannel("chat"));
      this.enqueue(id, async () => {
        await pc.setLocalDescription(await pc.createOffer());
        this.signaling.send("offer", { to: id, data: pc.localDescription.toJSON() });
      });
    } else {
      pc.ondatachannel = (e) => this.setupChannel(peer, e.channel);
    }
  }

  onOffer(from, offer) {
    this.enqueue(from, async (pc) => {
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      this.signaling.send("answer", { to: from, data: pc.localDescription.toJSON() });
    });
  }

  enqueue(id, task) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.queue = peer.queue.then(() => task(peer.pc)).catch((err) => console.error(`peer ${id}:`, err));
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.ui.removePeer(id);
  }

  setupChannel(peer, dc) {
    peer.dc = dc;
    dc.onmessage = (e) => {
      try {
        const { text } = JSON.parse(e.data);
        // The sender name comes from our signaling server (authenticated),
        // not from the message, so a peer cannot pretend to be someone else.
        if (typeof text === "string") this.ui.chat(peer.user, text.slice(0, 500));
      } catch { /* ignore malformed messages */ }
    };
  }

  sendChat(text) {
    const msg = JSON.stringify({ text });
    for (const { dc } of this.peers.values()) if (dc?.readyState === "open") dc.send(msg);
  }

  // ---- QoS: measure every second, adapt per peer connection ----

  async pollStats() {
    for (const [id, peer] of this.peers) {
      if (peer.pc.connectionState !== "connected") continue;
      const { metrics, state } = await readStats(peer.pc, peer.statsState);
      peer.statsState = state;
      if (peer.qos.update(metrics.link)) {
        console.log(`[qos] ${peer.user}: link is now ${peer.qos.level}`, metrics.link);
        this.applyLevel(peer);
      }
      this.ui.peerStats(id, metrics, peer.qos.level);
    }
  }

  // Caps bitrate / resolution / framerate of the video we send to this peer.
  async applyLevel(peer) {
    const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    Object.assign(params.encodings[0], LEVELS[peer.qos.level]);
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn("setParameters failed", err);
    }
  }

  // ---- Controls ----

  toggleTrack(kind) {
    const track = kind === "audio" ? this.localStream.getAudioTracks()[0] : this.cameraTrack;
    if (!track) return false;
    // A disabled track sends silence / black frames: the connection stays up.
    track.enabled = !track.enabled;
    return track.enabled;
  }

  async startScreenShare() {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    this.screenTrack = display.getVideoTracks()[0];
    // replaceTrack swaps what a sender transmits without renegotiating SDP.
    await this.replaceVideo(this.screenTrack);
    this.screenTrack.onended = () => this.stopScreenShare(); // browser "Stop sharing" button
    return this.screenTrack;
  }

  async stopScreenShare() {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    await this.replaceVideo(this.cameraTrack);
    this.ui.screenShareEnded?.();
  }

  async replaceVideo(track) {
    for (const { pc } of this.peers.values()) {
      // The receiver side of a transceiver always has a track, so its kind
      // tells us which sender is the video one.
      const video = pc.getTransceivers().find((t) => t.receiver.track.kind === "video");
      await video?.sender.replaceTrack(track);
    }
  }

  hangup() {
    clearInterval(this.statsTimer);
    this.screenTrack?.stop();
    this.signaling.send("leave");
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    for (const type of ["joined", "peer-joined", "peer-left", "offer", "answer", "ice"]) {
      this.signaling.on(type, () => {});
    }
  }
}
