import { expect, it, vi } from "vitest";
import { createRateLimitedDiagnostic } from "../src/core/utilities/RateLimitedDiagnostic";
it("bounds repeated diagnostics and retains counts without scheduling work", () => {
  let time = 0;
  const emit = vi.fn();
  const report = createRateLimitedDiagnostic(emit, () => time);
  for (let i = 0; i < 10000; i++) report("unreachable");
  expect(emit).toHaveBeenCalledTimes(1);
  report("other failure");
  expect(emit).toHaveBeenCalledTimes(2);
  time = 10000;
  report("unreachable");
  expect(emit).toHaveBeenLastCalledWith(
    "unreachable (9999 repeats suppressed)",
  );
  time = -1;
  report("unreachable");
  expect(emit).toHaveBeenLastCalledWith("unreachable");
});
