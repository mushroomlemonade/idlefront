import { ClientEnv } from "src/client/ClientEnv";
import {
  correspondingSourceUrl,
  sourceFileUrl,
  sourceRepositoryUrl,
} from "src/client/SourceLinks";
import { beforeEach, describe, expect, test } from "vitest";

describe("deployed corresponding-source links", () => {
  beforeEach(() => {
    window.BOOTSTRAP_CONFIG = undefined;
    ClientEnv.reset();
  });

  test("uses the public source repository in static development previews", () => {
    expect(correspondingSourceUrl()).toBe(sourceRepositoryUrl);
    expect(sourceFileUrl("LICENSE")).toBe(
      `${sourceRepositoryUrl}/blob/main/LICENSE`,
    );
  });

  test("pins source and license links to the deployed commit", () => {
    const commit = "4a9c2bf1e74d86f98d2d1f34b028dc07584dc930";
    window.BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      numWorkers: 1,
      turnstileSiteKey: "operator-key",
      jwtAudience: "idlefront.io",
      instanceId: "idlefront",
      gitCommit: commit,
    };

    expect(correspondingSourceUrl()).toBe(
      `${sourceRepositoryUrl}/tree/${commit}`,
    );
    expect(sourceFileUrl("LICENSE-ASSETS")).toBe(
      `${sourceRepositoryUrl}/blob/${commit}/LICENSE-ASSETS`,
    );
  });
});
