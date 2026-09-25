import { render } from "lit";
import { PersistentWorldCreationWizard } from "../../src/client/components/persistent-world/PersistentWorldCreationWizard";
import { worldModeSummary } from "../../src/client/components/persistent-world/WorldModeSummary";

describe("public game creation", () => {
  afterEach(() => document.body.replaceChildren());

  async function wizard(customGame: boolean) {
    const element = new PersistentWorldCreationWizard();
    element.customGame = customGame;
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  async function continueStep(element: PersistentWorldCreationWizard) {
    const button =
      element.querySelector<HTMLButtonElement>(
        ".pw-wizard__footer .pw-button--primary",
      ) ??
      element.querySelector<HTMLButtonElement>("footer .pw-button--primary");
    expect(button).not.toBeNull();
    button!.click();
    await element.updateComplete;
  }

  it("keeps navigation and progress in one panel outside every scrolling step", async () => {
    const element = await wizard(true);
    const name = element.querySelector<HTMLInputElement>('input[type="text"]')!;
    name.value = "Navigation test";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    const panel = element.querySelector(".pw-wizard__command-panel");
    for (let step = 0; step < 4; step++) {
      expect(element.querySelector(".pw-wizard__command-panel")).toBe(panel);
      expect(panel?.querySelector(".pw-wizard__header")).not.toBeNull();
      expect(panel?.querySelector(".pw-wizard__progress")).not.toBeNull();
      expect(panel?.querySelectorAll(".pw-wizard__footer button")).toHaveLength(
        2,
      );
      expect(
        element.querySelector(".pw-wizard__viewport .pw-wizard__footer"),
      ).toBeNull();
      if (step < 3) await continueStep(element);
    }
    expect(panel?.textContent).toContain("Create invitation");
  });

  it("offers public map presets and readable economic symbols without a debug flag", async () => {
    const element = await wizard(true);
    expect(element.querySelectorAll('input[name="game-preset"]')).toHaveLength(
      3,
    );
    expect(element.textContent).toContain("Earth");
    expect(
      [
        ...element.querySelectorAll<HTMLInputElement>(
          'input[name="game-preset"]',
        ),
      ].map((input) => input.value),
    ).toEqual(["quickplay", "longplay", "idlefront"]);
  });

  it("uses the host-start path through every custom wizard step", async () => {
    const element = await wizard(true);
    const input =
      element.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = "My custom room";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    await continueStep(element);
    await continueStep(element);
    expect(element.textContent).toContain("Host-controlled start");
    expect(element.querySelector('input[type="datetime-local"]')).toBeNull();
    await continueStep(element);
    expect(element.textContent).toContain("Starts when the host is ready");
    const create = vi.fn();
    element.addEventListener("world-create", create);
    await continueStep(element);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].detail.input).toMatchObject({
      startMode: "host",
      gamePreset: "quickplay",
      name: "My custom room",
    });
  });

  it("shows scheduled Earth as a fixed choice, not selectable custom economies", async () => {
    const element = await wizard(false);
    expect(element.textContent).toContain("Earth");
    expect(element.querySelectorAll('input[name="game-preset"]')).toHaveLength(
      3,
    );
    expect(element.querySelector('input[name="duration"]')).toBeNull();
  });

  it("renders modifier symbols without relying on mouse tooltips", () => {
    render(worldModeSummary("hd-earth-9x"), document.body);
    expect(document.body.textContent).toContain("Trade ships");
    expect(document.body.textContent).toContain("Trains");
    expect(document.body.textContent).toContain("Attack speed");
    expect(document.querySelectorAll("svg")).toHaveLength(3);
  });
});
