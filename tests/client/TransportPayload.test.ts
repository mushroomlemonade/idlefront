import { describe, expect, it } from "vitest";
import { webSocketBinaryPayload } from "../../src/client/Transport";

describe("webSocketBinaryPayload", () => {
  it("accepts ArrayBuffer frames", async () => {
    const payload = Uint8Array.from([1, 2, 3]).buffer;
    expect(new Uint8Array((await webSocketBinaryPayload(payload))!)).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  it("accepts Blob frames used by mobile WebViews", async () => {
    const payload = new Blob([Uint8Array.from([4, 5, 6])]);
    expect(new Uint8Array((await webSocketBinaryPayload(payload))!)).toEqual(
      Uint8Array.from([4, 5, 6]),
    );
  });

  it("copies an ArrayBuffer view without adjacent bytes", async () => {
    const source = Uint8Array.from([9, 7, 8, 9]);
    const payload = source.subarray(1, 3);
    expect(new Uint8Array((await webSocketBinaryPayload(payload))!)).toEqual(
      Uint8Array.from([7, 8]),
    );
  });

  it("leaves JSON text for schema parsing", async () => {
    expect(await webSocketBinaryPayload('{"type":"start"}')).toBeNull();
  });
});
