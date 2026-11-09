// Congestion detection demo, fully automated and isolated in Docker:
//   1. starts a coturn container and forces both browsers to relay through it
//   2. adds packet loss with `tc netem` INSIDE that container's network
//      namespace (the host network is not touched, no sudo needed)
//   3. checks the app detects congestion and lowers the sending bitrate
//   4. removes the loss and checks it recovers
//   npm run congestion
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 3459;
const SECRET = "congestion-demo-secret";
const NAME = "visio-netem-turn";
const LOSS = process.env.LOSS || "15%";
if (!/^\d+(\.\d+)?%$/.test(LOSS)) throw new Error("LOSS must look like 15%"); // goes into a shell command
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
};

// netem runs from a throwaway container sharing the TURN container's network.
const netem = (args) =>
  sh(`docker run --rm --net container:${NAME} --cap-add NET_ADMIN nicolaka/netshoot tc qdisc ${args}`);

sh(`docker rm -f ${NAME} 2>/dev/null || true`);
sh(`docker run -d --name ${NAME} --cap-add NET_ADMIN coturn/coturn:4.6 -n --listening-port=3478 ` +
  `--use-auth-secret --static-auth-secret=${SECRET} --realm=secure-visio --fingerprint ` +
  `--min-port=49160 --max-port=49200 --no-tls --no-dtls --no-cli --log-file=stdout`);
const turnIp = sh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${NAME}`);
console.log(`TURN container at ${turnIp}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visio-cong-"));
const server = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env, PORT, USERS_FILE: path.join(tmp, "users.json"), CERT_DIR: path.join(tmp, "none"),
    TURN_SECRET: SECRET, TURN_URLS: `turn:${turnIp}:3478?transport=udp`, STUN_URLS: "",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running") && resolve()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

const statsOf = (page) => page.$eval(".tile:not(.local) .stats", (e) => e.textContent);
const levelOf = (page) => page.$eval(".tile:not(.local) .badge", (e) => e.textContent);
const sendKbps = async (page) => Number((await statsOf(page)).match(/send .* (\d+) kbps/)?.[1]);

try {
  const pages = [];
  for (const name of ["alice", "bob"]) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.on("console", (m) => m.text().startsWith("[qos]") && console.log(`      [${name}] ${m.text()}`));
    await page.goto(`http://localhost:${PORT}`);
    await page.fill("#username", `${name}${Date.now() % 10000}`);
    await page.fill("#password", "password123");
    await page.click('button[data-action="register"]');
    await page.waitForSelector("#lobbyView:not([hidden])");
    await page.check("#relayOnly");
    await page.click("#joinForm button");
    await page.waitForSelector("#callView:not([hidden])");
    pages.push(page);
  }
  const [alice] = pages;

  // Let the call ramp up on a clean network.
  await sleep(12000);
  const before = await sendKbps(alice);
  check((await levelOf(alice)) === "good", `clean network: level good, sending ${before} kbps`);
  console.log((await statsOf(alice)).replace(/^/gm, "      "));

  console.log(`\nApplying netem loss ${LOSS} on the TURN container...`);
  netem(`add dev eth0 root netem loss ${LOSS}`);

  const detected = await alice.waitForFunction(
    () => document.querySelector(".tile:not(.local) .badge")?.textContent === "congested",
    null, { timeout: 20000 }).then(() => true, () => false);
  check(detected, "congestion detected (level congested)");
  await sleep(5000);
  const during = await sendKbps(alice);
  check(during <= 200, `sending bitrate capped: ${before} -> ${during} kbps (cap 150 kbps)`);
  console.log((await statsOf(alice)).replace(/^/gm, "      "));
  fs.mkdirSync("docs", { recursive: true });
  await alice.screenshot({ path: "docs/screenshot-congested.png" });

  console.log("\nRemoving netem...");
  netem("del dev eth0 root");

  // Recovery is deliberately slow: 5 good samples per level, 2 levels.
  const recovered = await alice.waitForFunction(
    () => document.querySelector(".tile:not(.local) .badge")?.textContent === "good",
    null, { timeout: 30000 }).then(() => true, () => false);
  check(recovered, "network back to normal: level recovers to good");
  console.log((await statsOf(alice)).replace(/^/gm, "      "));
} finally {
  await browser.close();
  server.kill();
  sh(`docker rm -f ${NAME}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
