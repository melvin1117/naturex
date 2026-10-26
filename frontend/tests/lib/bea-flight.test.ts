import { describe, expect, it } from "vitest";

import { flightPose, planFlight } from "@/lib/bea-flight";

const HEADLINE = { left: 112, top: 260, width: 470, height: 170 };
const AVATAR = { left: 1282, top: 820, width: 32, height: 32 };
const VIEWPORT = { width: 1440, height: 900 };

describe("Bea's flight on the welcome", () => {
  const plan = planFlight(HEADLINE, 87, AVATAR, VIEWPORT);

  it("starts off the left edge and ends on the Ask Bea avatar, at its size", () => {
    expect(plan.start.x).toBeLessThan(0);
    const end = flightPose(plan, plan.writeMs + plan.flyMs);
    expect(end.stage).toBe("landed");
    expect(end.x).toBeCloseTo(AVATAR.left + 16);
    expect(end.y).toBeCloseTo(AVATAR.top + (32 * 64.5) / 120);
    // In the medallion she's drawn at 75% of its width.
    expect(end.scale * plan.size).toBeCloseTo(24);
  });

  it("writes the headline as she passes, all of it before she flies on", () => {
    const written = [0.2, 0.4, 0.6, 0.8].map(
      (f) => flightPose(plan, plan.writeMs * f).written,
    );
    expect(written).toEqual([...written].sort((a, b) => a - b));
    expect(flightPose(plan, plan.writeMs - 1).written).toBeGreaterThan(
      HEADLINE.width,
    );
    expect(flightPose(plan, plan.writeMs).stage).toBe("flying");
  });

  it("sizes her to the headline, within bounds, and keeps her on a phone's screen", () => {
    expect(plan.size).toBeCloseTo(100, 0);
    const phone = planFlight(
      { left: 20, top: 96, width: 350, height: 92 },
      46,
      { left: 337, top: 790, width: 32, height: 32 },
      { width: 390, height: 844 },
    );
    expect(phone.size).toBe(56);
    expect(phone.turn.x).toBeLessThanOrEqual(390 - phone.size * 0.6);
  });

  it("takes about a second for each leg, never much more", () => {
    for (const p of [
      plan,
      planFlight(HEADLINE, 87, { ...AVATAR, left: 5000, top: 5000 }, VIEWPORT),
    ]) {
      expect(p.writeMs).toBeGreaterThanOrEqual(900);
      expect(p.writeMs).toBeLessThanOrEqual(1500);
      expect(p.flyMs).toBeGreaterThanOrEqual(800);
      expect(p.flyMs).toBeLessThanOrEqual(1200);
    }
  });
});
