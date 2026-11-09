import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, CongestionController } from "../public/js/qos.js";

const GOOD = { lossPct: 0, rttMs: 40, jitterMs: 5 };
const DEGRADED = { lossPct: 4, rttMs: 40, jitterMs: 5 };
const CONGESTED = { lossPct: 12, rttMs: 40, jitterMs: 5 };

test("classify uses the worst metric", () => {
  assert.equal(classify(GOOD), "good");
  assert.equal(classify(DEGRADED), "degraded");
  assert.equal(classify({ lossPct: 0, rttMs: 600, jitterMs: 5 }), "congested");
  assert.equal(classify({ lossPct: 0, rttMs: 40, jitterMs: 45 }), "degraded");
});

test("one bad sample is not enough to downgrade", () => {
  const c = new CongestionController();
  assert.equal(c.update(CONGESTED), false);
  assert.equal(c.level, "good");
  c.update(GOOD); // streak broken
  assert.equal(c.update(CONGESTED), false);
  assert.equal(c.level, "good");
});

test("two bad samples in a row jump straight to the measured level", () => {
  const c = new CongestionController();
  c.update(CONGESTED);
  assert.equal(c.update(CONGESTED), true);
  assert.equal(c.level, "congested");
});

test("recovery is slow and one level at a time", () => {
  const c = new CongestionController();
  c.update(CONGESTED);
  c.update(CONGESTED);
  for (let i = 0; i < 4; i++) assert.equal(c.update(GOOD), false);
  assert.equal(c.update(GOOD), true);
  assert.equal(c.level, "degraded");
  for (let i = 0; i < 5; i++) c.update(GOOD);
  assert.equal(c.level, "good");
});

test("empty samples (no RTCP report yet) change nothing", () => {
  const c = new CongestionController();
  assert.equal(c.update({}), false);
  assert.equal(c.level, "good");
});
