import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  window.dispatchEvent(new Event("load"));
  document.head.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("commits only the newest load synchronously and preserves stylesheet order", async () => {
  vi.resetModules();
  vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
  document.head.innerHTML =
    '<style>.inline { color: red; }</style><link rel="stylesheet" href="/first.css"><link rel="stylesheet" href="/second.css">';
  const requests: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve))),
  );
  const replaceSync = vi.fn();
  vi.stubGlobal(
    "CSSStyleSheet",
    class {
      replaceSync = replaceSync;
    },
  );
  const { documentStylesSheet } =
    await import("../../src/client/components/baseComponents/SharedStyles");
  const sheet = documentStylesSheet();
  expect(documentStylesSheet()).toBe(sheet);
  window.dispatchEvent(new Event("load"));
  expect(requests).toHaveLength(4);
  requests[3](new Response(".second {}"));
  requests[2](new Response(".first {}"));
  await vi.waitFor(() => expect(replaceSync).toHaveBeenCalledTimes(1));
  expect(replaceSync).toHaveBeenCalledWith(
    ".inline { color: red; }\n.first {}\n.second {}",
  );
  requests[0](new Response(".oldFirst {}"));
  requests[1](new Response(".oldSecond {}"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(replaceSync).toHaveBeenCalledTimes(1);
});
