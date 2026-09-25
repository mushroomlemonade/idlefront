import { PersistentWorldQuickChat } from "../../src/client/components/persistent-world/PersistentWorldComponents";

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));

describe("PersistentWorldQuickChat send control", () => {
  let chat: PersistentWorldQuickChat;

  beforeEach(async () => {
    chat = new PersistentWorldQuickChat();
    document.body.appendChild(chat);
    await chat.updateComplete;
  });

  afterEach(() => {
    chat.remove();
  });

  test("reserves both labels while exposing the current async state", async () => {
    const phrase = chat.querySelector<HTMLButtonElement>(".pw-phrase-button");
    expect(phrase).not.toBeNull();

    phrase?.click();
    await chat.updateComplete;

    const button = chat.querySelector<HTMLButtonElement>(
      ".pw-chat__send-button",
    );
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-busy")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("chat.send");
    expect(
      button?.querySelector(".pw-chat__send-label--idle")?.textContent,
    ).toBe("chat.send");
    expect(
      button?.querySelector(".pw-chat__send-label--busy")?.textContent,
    ).toBe("Sending…");

    button?.click();
    await chat.updateComplete;

    expect(button?.disabled).toBe(true);
    expect(button?.classList.contains("is-sending")).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe("Sending quick chat");

    chat.sendingComplete();
    await chat.updateComplete;

    expect(button?.disabled).toBe(false);
    expect(button?.classList.contains("is-sending")).toBe(false);
    expect(button?.getAttribute("aria-busy")).toBe("false");
  });
});
