import { FrameRateSetting } from "../../src/client/components/FrameRateSetting";
import { UserSettings } from "../../src/core/game/UserSettings";

test("frame rate defaults to 60 and persists supported choices through 240", async () => {
  const settings = new UserSettings();
  settings.removeCached("settings.frameRateLimit");
  expect(settings.frameRateLimit()).toBe(60);
  const component = new FrameRateSetting();
  document.body.append(component);
  await component.updateComplete;
  const select = component.querySelector("select")!;
  expect(select.value).toBe("60");
  select.value = "240";
  select.dispatchEvent(new Event("change"));
  expect(new UserSettings().frameRateLimit()).toBe(240);
  settings.setFrameRateLimit(999);
  expect(settings.frameRateLimit()).toBe(240);
  component.remove();
  settings.removeCached("settings.frameRateLimit");
});
