import { PlayerInfoOverlay } from "../../src/client/hud/layers/PlayerInfoOverlay";
import type { EventBus } from "../../src/core/EventBus";

describe("player-info-overlay", () => {
  let overlay: PlayerInfoOverlay;

  beforeEach(async () => {
    overlay = new PlayerInfoOverlay();
    overlay.eventBus = { on: vi.fn() } as unknown as EventBus;
    document.body.append(overlay);
    overlay.init();
    overlay.tick();
    await overlay.updateComplete;
  });

  afterEach(() => {
    overlay.remove();
  });

  test("mounts no tray surface while no player or unit is selected", async () => {
    expect(overlay.querySelector(".atlas-player-info-positioner")).toBeNull();
    expect(overlay.querySelector(".atlas-player-info-surface")).toBeNull();

    // A visibility event arriving before selection data must not flash an
    // empty bordered surface into the Dynamic Island lane.
    overlay.setVisible(true);
    await overlay.updateComplete;

    expect(overlay.querySelector(".atlas-player-info-positioner")).toBeNull();
    expect(overlay.querySelector(".atlas-player-info-surface")).toBeNull();
  });
});
