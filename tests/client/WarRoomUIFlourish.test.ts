import { UiFlourishController } from "../../src/client/ui/WarRoomUI";

describe("UiFlourishController", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.dataset.uiFidelity = "full";
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each(["atlas-quick-play", "pw-entry-control"])(
    "originates the %s flourish at the exact pointer location",
    (className) => {
      const controller = new UiFlourishController(document);
      const play = document.createElement("button");
      play.className = className;
      document.body.append(play);

      play.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 73,
          clientY: 219,
          detail: 1,
        }),
      );

      const flourish = document.querySelector<HTMLElement>(
        ".atlas-flourish--deploy",
      );
      expect(flourish?.style.getPropertyValue("--atlas-flourish-x")).toBe(
        "73px",
      );
      expect(flourish?.style.getPropertyValue("--atlas-flourish-y")).toBe(
        "219px",
      );

      controller.dispose();
    },
  );

  test("uses the button centre for keyboard activation", () => {
    const controller = new UiFlourishController(document);
    const play = document.createElement("button");
    play.className = "atlas-quick-play";
    play.getBoundingClientRect = vi.fn(() => ({
      x: 40,
      y: 80,
      left: 40,
      top: 80,
      right: 240,
      bottom: 140,
      width: 200,
      height: 60,
      toJSON: () => ({}),
    }));
    document.body.append(play);

    play.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        detail: 0,
      }),
    );

    const flourish = document.querySelector<HTMLElement>(
      ".atlas-flourish--deploy",
    );
    expect(flourish?.style.getPropertyValue("--atlas-flourish-x")).toBe(
      "140px",
    );
    expect(flourish?.style.getPropertyValue("--atlas-flourish-y")).toBe(
      "110px",
    );

    controller.dispose();
  });
});
