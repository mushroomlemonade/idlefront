import { afterEach, describe, expect, it } from "vitest";
import { PersistentWorldRepository } from "../../../src/server/persistent/PersistentWorldRepository";
import { PersistentWorldService } from "../../../src/server/persistent/PersistentWorldService";

describe("password-protected world identities", () => {
  const now = 2_000_000_000_000;
  let service: PersistentWorldService;
  afterEach(() => service?.close());

  function setup() {
    const repository = new PersistentWorldRepository({
      dbPath: ":memory:",
      now: () => now,
    });
    service = new PersistentWorldService(repository, { now: () => now });
    const host = service.createGuestSession({ displayName: "Captain" });
    service.bindGuestGameplayIdentity(host.bearerToken, (id) => id);
    const world = service.createWorld(host.bearerToken, {
      name: "Friends",
      password: "party",
      targetDuration: "1d",
      access: "private",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now + 120_000,
    });
    return { host, world, id: world.snapshot.world.id, repository };
  }

  it("requires the password even with an invitation and keeps separate players independent", async () => {
    const { id, world } = setup();
    const friend = service.createGuestSession({ displayName: "Friend" });
    expect(() =>
      service.rsvp(id, friend.bearerToken, {
        invitationSecret: world.invitationSecret,
      }),
    ).toThrow("Enter the game password");
    await expect(
      service.unlockWorld(id, friend.bearerToken, "wrong", "Friend"),
    ).rejects.toThrow("incorrect");
    await service.unlockWorld(id, friend.bearerToken, "party", "Friend");
    const snapshot = service.rsvp(id, friend.bearerToken, {});
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.viewer.identity?.id).toBe(friend.session.identity.id);
  });

  it("recovers the original nation on another device without granting its other worlds", async () => {
    const { id, host } = setup();
    const other = service.createWorld(host.bearerToken, {
      name: "Other",
      targetDuration: "1d",
      access: "private",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now + 120_000,
    });
    const phone = service.createGuestSession({ displayName: "Captain" });
    await service.unlockWorld(id, phone.bearerToken, "party", "Captain");
    const snapshot = service.rsvp(id, phone.bearerToken, {});
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.viewer.identity?.id).toBe(host.session.identity.id);
    expect(
      service.listMine(phone.bearerToken).map((card) => card.world.id),
    ).toEqual([id]);
    expect(() =>
      service.getSnapshot(other.snapshot.world.id, phone.bearerToken),
    ).toThrow("invitation");
    expect(service.resumeSession(phone.bearerToken).identity.id).toBe(
      phone.session.identity.id,
    );
  });

  it("does not treat different capitalization as the same nation", async () => {
    const { id } = setup();
    const friend = service.createGuestSession({ displayName: "captain" });
    await service.unlockWorld(id, friend.bearerToken, "party", "captain");
    const snapshot = service.rsvp(id, friend.bearerToken, {});
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.viewer.identity?.displayName).toBe("captain");
  });

  it("stores a salted password hash, not the password", () => {
    const { repository, id } = setup();
    expect(repository.worldPassword(id)).toMatch(/^[a-f0-9]{32}:[a-f0-9]{64}$/);
    expect(repository.worldPassword(id)).not.toContain("party");
  });
});
