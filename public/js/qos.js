// Congestion detection and the quality level we send at.
//
// The browser already runs its own congestion control (Google Congestion
// Control adjusts the bitrate from delay and loss). This module is an
// application-level policy on top of it: it watches the link quality that
// the *remote* peer reports back to us over RTCP, classifies it, and caps
// what we send so that audio and interactivity survive a bad network.
//
// Pure logic, no browser APIs, so it can be unit tested in Node.

// What we send at each level (applied with RTCRtpSender.setParameters).
export const LEVELS = {
  good: { maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  degraded: { maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 24 },
  congested: { maxBitrate: 150_000, scaleResolutionDownBy: 4, maxFramerate: 15 },
};

const ORDER = ["good", "degraded", "congested"];

// A sample is "degraded" / "congested" if ANY metric crosses its threshold.
// Values chosen from ITU-T G.114 (one-way delay under 150 ms feels natural,
// so RTT 250-300 ms starts to hurt) and usual VoIP loss tolerances.
export const THRESHOLDS = {
  degraded: { lossPct: 2, rttMs: 250, jitterMs: 30 },
  congested: { lossPct: 8, rttMs: 500, jitterMs: 60 },
};

export function classify({ lossPct, rttMs, jitterMs }) {
  const over = (t) => lossPct > t.lossPct || rttMs > t.rttMs || jitterMs > t.jitterMs;
  if (over(THRESHOLDS.congested)) return "congested";
  if (over(THRESHOLDS.degraded)) return "degraded";
  return "good";
}

// Hysteresis: go down fast (DOWN_AFTER bad samples in a row), come back up
// slowly and one level at a time (UP_AFTER good samples). Without this the
// level would flap every second on a noisy network, and every change costs
// a visible quality jump.
export class CongestionController {
  constructor({ downAfter = 2, upAfter = 5 } = {}) {
    this.level = "good";
    this.downAfter = downAfter;
    this.upAfter = upAfter;
    this.badStreak = 0;
    this.goodStreak = 0;
  }

  // Feeds one sample (about once per second). Returns true if the level changed.
  update(sample) {
    if (sample.lossPct == null && sample.rttMs == null && sample.jitterMs == null) return false;

    const current = ORDER.indexOf(this.level);
    const target = ORDER.indexOf(classify(sample));

    if (target > current) {
      this.goodStreak = 0;
      if (++this.badStreak >= this.downAfter) return this.setLevel(ORDER[target]);
    } else if (target < current) {
      this.badStreak = 0;
      if (++this.goodStreak >= this.upAfter) return this.setLevel(ORDER[current - 1]);
    } else {
      this.badStreak = 0;
      this.goodStreak = 0;
    }
    return false;
  }

  setLevel(level) {
    this.level = level;
    this.badStreak = 0;
    this.goodStreak = 0;
    return true;
  }
}
