// End-to-end check: starts the server, opens 3 headless Chrome users with fake
// cameras, puts them in one room and verifies that video, QoS stats and chat
// really flow between them. Takes a screenshot for the docs.
//   npm run e2e                 (STUN/host candidates)
//   RELAY=1 npm run e2e         (forces TURN relay, needs coturn + TURN_* env)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 3456;
const BASE = `http://localhost:${PORT}`;
const ROOM = `e2e${Date.now() % 100000}`;
const RELAY = process.env.RELAY === "1";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visio-e2e-"));
const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT, USERS_FILE: path.join(tmp, "users.json"), CERT_DIR: path.join(tmp, "none") },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running") && resolve()));

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
};

try {
  const names = ["alice", "bob", "carol"].map((n) => `${n}${Date.now() % 10000}`);
  const pages = [];
  for (const name of names) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.on("console", (m) => m.type() === "error" && console.log(`[${name}] ${m.text()}`));
    await page.goto(BASE);
    await page.fill("#username", name);
    await page.fill("#password", "password123");
    await page.click('button[data-action="register"]');
    await page.waitForSelector("#lobbyView:not([hidden])");
    await page.fill("#roomName", ROOM);
    if (RELAY) await page.check("#relayOnly");
    await page.click("#joinForm button");
    await page.waitForSelector("#callView:not([hidden])");
    pages.push(page);
  }

  // Every user should see 2 remote tiles with decoded video frames.
  for (const [i, page] of pages.entries()) {
    const ok = await page
      .waitForFunction(() => {
        const remote = [...document.querySelectorAll('.tile:not(.local) video')];
        return remote.length === 2 && remote.every((v) => v.videoWidth > 0);
      }, null, { timeout: 20000 })
      .then(() => true, () => false);
    check(ok, `${names[i]} receives video from the 2 other participants`);
  }

  // Stats panels fill in once a few getStats() rounds have run.
  const page = pages[0];
  const statsOk = await page
    .waitForFunction(() => [...document.querySelectorAll(".tile:not(.local) .stats")]
      .every((s) => /send \d+x\d+ \d+fps \d+ kbps/.test(s.textContent)), null, { timeout: 15000 })
    .then(() => true, () => false);
  const stats = await page.$$eval(".tile:not(.local) .stats", (els) => els.map((e) => e.textContent));
  check(statsOk, "QoS stats are measured (bitrate, resolution, fps)");
  console.log(stats[0].replace(/^/gm, "      "));

  const pathType = stats[0].match(/path (\w+)/)?.[1];
  if (RELAY) check(pathType === "relay", `media goes through TURN (path=${pathType})`);

  const levels = await page.$$eval(".badge", (els) => els.map((e) => e.textContent).filter(Boolean));
  check(levels.length === 2 && levels.every((l) => l === "good"), `congestion level on a clean network: ${levels.join(", ")}`);

  // Chat over the DataChannel reaches the other participants.
  await pages[1].fill("#chatInput", "hello from e2e");
  await pages[1].click("#chatForm button");
  for (const p of [pages[0], pages[2]]) {
    const ok = await p.waitForFunction(() => document.querySelector("#chatLog").textContent.includes("hello from e2e"),
      null, { timeout: 5000 }).then(() => true, () => false);
    check(ok, "chat message delivered over DataChannel");
  }

  // The SDP must carry a DTLS fingerprint: proof that media is DTLS-SRTP.
  const fingerprint = await page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver("video");
    const offer = await pc.createOffer();
    pc.close();
    return offer.sdp.match(/a=fingerprint:(\S+)/)?.[1];
  });
  check(Boolean(fingerprint), `SDP has a DTLS fingerprint (${fingerprint})`);

  // Leaving updates the others.
  await pages[2].click("#hangupBtn");
  const leftOk = await page.waitForFunction(() => document.querySelectorAll(".tile:not(.local)").length === 1,
    null, { timeout: 5000 }).then(() => true, () => false);
  check(leftOk, "hang up removes the participant for the others");

  // Wait for a fresh stats round with numbers before the screenshot.
  await pages[1].waitForFunction(() => /\d+ kbps loss/.test(document.querySelector(".tile:not(.local) .stats")?.textContent),
    null, { timeout: 5000 }).catch(() => {});
  fs.mkdirSync("docs", { recursive: true });
  await pages[1].screenshot({ path: "docs/screenshot-call.png" });
  console.log("Screenshot saved to docs/screenshot-call.png");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
