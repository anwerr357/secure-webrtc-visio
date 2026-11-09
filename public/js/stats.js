// Reads QoS metrics from RTCPeerConnection.getStats().
//
// getStats() returns many report types. The ones we use:
//   outbound-rtp        what we send (bytes, resolution, fps, and why the
//                       encoder is limited: "bandwidth" or "cpu")
//   inbound-rtp         what we receive (bytes, packets lost, jitter)
//   remote-inbound-rtp  what the OTHER peer says about our stream, sent back
//                       in RTCP Receiver Reports: loss, jitter, round-trip time.
//                       This is the signal congestion detection uses, because
//                       it describes the path our packets travel.
//   candidate-pair      the network path ICE chose (RTT, estimated bandwidth)
//
// Byte counters are cumulative, so bitrate = delta bytes / delta time between
// two calls. `prev` holds the previous counters for that computation.

export async function readStats(pc, prev = {}) {
  const report = await pc.getStats();
  const metrics = { out: {}, in: {}, link: {} };
  const next = {};

  let selectedPairId;
  report.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId;
  });

  report.forEach((s) => {
    const isVideo = s.kind === "video";
    switch (s.type) {
      case "outbound-rtp":
        if (!isVideo) break;
        next.out = { bytes: s.bytesSent, ts: s.timestamp };
        Object.assign(metrics.out, {
          kbps: kbps(next.out, prev.out),
          width: s.frameWidth,
          height: s.frameHeight,
          fps: s.framesPerSecond,
          limitation: s.qualityLimitationReason,
        });
        break;

      case "inbound-rtp":
        if (!isVideo) break;
        next.in = { bytes: s.bytesReceived, ts: s.timestamp, lost: s.packetsLost, received: s.packetsReceived };
        Object.assign(metrics.in, {
          kbps: kbps(next.in, prev.in),
          width: s.frameWidth,
          height: s.frameHeight,
          fps: s.framesPerSecond,
          lossPct: lossPct(next.in, prev.in),
          jitterMs: s.jitter * 1000,
        });
        break;

      case "remote-inbound-rtp":
        if (!isVideo) break;
        Object.assign(metrics.link, {
          rttMs: s.roundTripTime != null ? s.roundTripTime * 1000 : undefined,
          lossPct: s.fractionLost != null ? s.fractionLost * 100 : undefined,
          jitterMs: s.jitter != null ? s.jitter * 1000 : undefined,
        });
        break;

      case "candidate-pair":
        // Chrome marks the pair on the transport report, Firefox uses `selected`.
        if (s.id !== selectedPairId && !s.selected) break;
        metrics.link.pairRttMs = s.currentRoundTripTime != null ? s.currentRoundTripTime * 1000 : undefined;
        metrics.link.availableKbps = s.availableOutgoingBitrate != null ? s.availableOutgoingBitrate / 1000 : undefined;
        metrics.link.candidateType = report.get(s.localCandidateId)?.candidateType; // host | srflx | relay
        break;
    }
  });

  // Before the first RTCP report arrives, fall back to the ICE pair RTT.
  metrics.link.rttMs ??= metrics.link.pairRttMs;
  return { metrics, state: next };
}

function kbps(curr, prev) {
  if (!prev || curr.ts <= prev.ts) return undefined;
  return ((curr.bytes - prev.bytes) * 8) / (curr.ts - prev.ts); // bits per ms = kbit/s
}

function lossPct(curr, prev) {
  if (!prev) return undefined;
  const lost = curr.lost - prev.lost;
  const total = lost + (curr.received - prev.received);
  return total > 0 ? (Math.max(lost, 0) / total) * 100 : 0;
}
