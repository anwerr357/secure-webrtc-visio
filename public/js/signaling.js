// Client side of the signaling protocol (see src/signaling.js on the server).

export class Signaling {
  constructor() {
    this.handlers = new Map();
  }

  // Opens the WebSocket and authenticates with the JWT as first message.
  // Resolves with our peer id once the server says "welcome".
  connect(token) {
    // wss:// when the page is on https:// so signaling is encrypted too.
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${scheme}://${location.host}/ws`);

    return new Promise((resolve, reject) => {
      this.ws.onopen = () => this.send("auth", { token });
      this.ws.onclose = (e) => {
        reject(new Error(e.reason || "Connection closed"));
        this.emit("closed", { reason: e.reason });
      };
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "welcome") resolve(msg);
        this.emit(msg.type, msg);
      };
    });
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  emit(type, msg) {
    this.handlers.get(type)?.(msg);
  }

  send(type, payload = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  close() {
    this.ws?.close();
  }
}
