import fs from "node:fs";
import type { DeploymentDrainStatus } from "./MasterLobbyService";

export function serializeDeploymentDrainStatus(
  instanceId: string,
  status: DeploymentDrainStatus,
  updatedAt: number = Date.now(),
): string {
  const safeInstanceId = /^[A-Za-z0-9_-]{1,64}$/.test(instanceId)
    ? instanceId
    : "unknown";
  const state = !status.draining ? "idle" : status.ready ? "ready" : "draining";
  return (
    [
      "openfront-drain-v1",
      safeInstanceId,
      state,
      status.blockingGames,
      status.managedGames,
      status.lobbyGames,
      status.activeClients,
      status.workersReported,
      status.workersExpected,
      status.pendingAdmissions,
      updatedAt,
    ].join(" ") + "\n"
  );
}

export function writeDeploymentDrainStatus(
  statusPath: string,
  instanceId: string,
  status: DeploymentDrainStatus,
): void {
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    serializeDeploymentDrainStatus(instanceId, status),
    { mode: 0o600 },
  );
  fs.renameSync(temporaryPath, statusPath);
}

export function removeDeploymentDrainStatus(statusPath: string): void {
  fs.rmSync(statusPath, { force: true });
}
