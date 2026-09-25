import { describe, expect, it, vi } from "vitest";
import { serializeDeploymentDrainStatus } from "../../src/server/DeploymentDrainStatusFile";
import { GameManager } from "../../src/server/GameManager";
import { GamePhase } from "../../src/server/GameServer";

const log: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function fakeGame(phase: GamePhase, managed: boolean, clients: number) {
  return {
    phase: vi.fn(() => phase),
    managedRequestId: vi.fn(() => (managed ? "managed-request" : undefined)),
    activeClients: Array.from({ length: clients }, () => ({})),
    cancelForDeploymentDrain: vi.fn(),
  };
}

describe("deployment drain", () => {
  it("blocks ordinary active games but treats journaled managed games as restart-safe", () => {
    vi.useFakeTimers();
    try {
      const manager = new GameManager(log);
      const ordinary = fakeGame(GamePhase.Active, false, 2);
      const managed = fakeGame(GamePhase.Active, true, 1);
      const lobby = fakeGame(GamePhase.Lobby, false, 1);
      (manager as any).games = new Map([
        ["ordinary", ordinary],
        ["managed", managed],
        ["lobby", lobby],
      ]);

      manager.setDeploymentDraining(true);

      expect(manager.deploymentDrainStatus()).toEqual({
        blockingGames: 1,
        managedGames: 1,
        lobbyGames: 1,
        activeClients: 4,
        pendingAdmissions: 0,
      });
      expect(ordinary.cancelForDeploymentDrain).toHaveBeenCalledOnce();
      expect(managed.cancelForDeploymentDrain).toHaveBeenCalledOnce();
      expect(lobby.cancelForDeploymentDrain).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("serializes a strict single-line status for the root deploy wrapper", () => {
    expect(
      serializeDeploymentDrainStatus(
        "abc123",
        {
          draining: true,
          ready: false,
          workersExpected: 2,
          workersReported: 2,
          blockingGames: 1,
          managedGames: 3,
          lobbyGames: 0,
          activeClients: 5,
          pendingAdmissions: 1,
        },
        123456,
      ),
    ).toBe("openfront-drain-v1 abc123 draining 1 3 0 5 2 2 1 123456\n");
  });

  it("holds readiness until matchmaking polls begun before drain have settled", () => {
    vi.useFakeTimers();
    try {
      const manager = new GameManager(log);
      expect(manager.beginMatchmakingPoll()).toBe(true);
      manager.setDeploymentDraining(true);
      expect(manager.beginMatchmakingPoll()).toBe(false);
      expect(manager.deploymentDrainStatus().pendingAdmissions).toBe(1);

      manager.endMatchmakingPoll();
      expect(manager.deploymentDrainStatus().pendingAdmissions).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
