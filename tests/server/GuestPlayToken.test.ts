import { describe, expect, it } from "vitest";
import {
  issueGuestPlayToken,
  verifyGuestPlayToken,
} from "../../src/server/GuestPlayToken";

describe("guest play tokens", () => {
  it("restricts a recovered nation credential to its game", () => {
    const now = Date.now();
    const token = issueGuestPlayToken("pwi_test_identity", now, "game1234");
    expect(verifyGuestPlayToken(token, now, "game1234")).toBe(
      "pwi_test_identity",
    );
    expect(verifyGuestPlayToken(token, now, "other123")).toBeNull();
    expect(verifyGuestPlayToken(token, now)).toBeNull();
  });
  it("accepts every issued signature, including embedded underscores", () => {
    const issuedAt = 1_700_000_000_000;
    let embeddedUnderscores = 0;
    for (let i = 0; i < 128; i++) {
      const identity = `pwi_regression_${i}`;
      const token = issueGuestPlayToken(identity, issuedAt + i);
      if (token.slice(-43).includes("_")) embeddedUnderscores++;
      expect(verifyGuestPlayToken(token, issuedAt + 129)).toBe(identity);
    }
    expect(embeddedUnderscores).toBeGreaterThan(0);
  });
  it("round-trips a world identity without exposing a JWT", () => {
    const issuedAt = 1_700_000_000_000;
    const token = issueGuestPlayToken("pwi_test_identity", issuedAt);

    expect(token.startsWith("guest_")).toBe(true);
    expect(verifyGuestPlayToken(token, issuedAt + 1)).toBe("pwi_test_identity");
  });

  it("rejects tampered and expired credentials", () => {
    const issuedAt = 1_700_000_000_000;
    const token = issueGuestPlayToken("pwi_test_identity", issuedAt);
    expect(verifyGuestPlayToken(`${token}x`, issuedAt)).toBeNull();
    expect(
      verifyGuestPlayToken(token, issuedAt + 14 * 24 * 60 * 60 * 1000),
    ).toBeNull();
  });
});
