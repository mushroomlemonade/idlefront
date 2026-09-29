import { describe, expect, it, vi } from "vitest";
import { LeaderboardDashboard } from "../../src/client/hud/layers/LeaderboardDashboard";
import { LeaderboardHistory } from "../../src/client/hud/layers/lib/LeaderboardHistory";
import type { PlayerStats } from "../../src/client/hud/layers/PlayerStats";
import type { GameView } from "../../src/client/view";

describe("shared leaderboard controls", () => {
  it("sorts the table and graph together in both directions", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    const dashboard = new LeaderboardDashboard();
    dashboard.game = {
      players: () => [],
      myPlayer: () => null,
      config: () => ({ gameConfig: () => ({}) }),
      numLandTiles: () => 100,
      numTilesWithFallout: () => 0,
    } as unknown as GameView;
    dashboard.history = new LeaderboardHistory();
    dashboard.open = true;
    document.body.append(dashboard);
    await dashboard.updateComplete;
    const table = dashboard.querySelector("player-stats") as PlayerStats;
    const sort = vi.spyOn(table, "sortBy");
    const metric = dashboard.querySelector<HTMLSelectElement>(
      '[aria-label="rank and graph metric"]',
    )!;
    metric.value = "gold";
    metric.dispatchEvent(new Event("change"));
    await dashboard.updateComplete;
    expect(sort).toHaveBeenLastCalledWith("gold", "desc");
    dashboard
      .querySelector<HTMLButtonElement>(".atlas-standings-toolbar button")!
      .click();
    await dashboard.updateComplete;
    expect(sort).toHaveBeenLastCalledWith("gold", "asc");
    expect(
      dashboard.querySelector(".atlas-standings-toolbar button")?.textContent,
    ).toContain("lowest");
    expect(
      dashboard.querySelector<HTMLSelectElement>(
        '[aria-label="history time range"]',
      )!.value,
    ).toBe("9000");
    dashboard.remove();
  });
});
