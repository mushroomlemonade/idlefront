import { playerTextureCapacity } from "../../src/client/render/PlayerTextureCapacity";

describe("playerTextureCapacity", () => {
  it("covers the complete large-bot roster", () => {
    expect(playerTextureCapacity(2000, 8, false)).toBe(2048);
  });

  it("keeps the established minimum for ordinary flat maps", () => {
    expect(playerTextureCapacity(200, 8, false)).toBe(1024);
  });

  it("keeps paged maps ready for their complete owner range", () => {
    expect(playerTextureCapacity(2000, 8, true)).toBe(4096);
  });

  it("never exceeds the packed owner capacity", () => {
    expect(playerTextureCapacity(5000, 100, false)).toBe(4096);
  });
});
