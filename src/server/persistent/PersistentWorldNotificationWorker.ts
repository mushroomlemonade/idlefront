import type { PersistentWorldNotificationKind } from "../../core/PersistentWorldSchemas";
import {
  PersistentWorldRepository,
  PersistentWorldRepositoryError,
  type ClaimPersistentWorldNotificationsOptions,
  type PersistentWorldNotificationDispatchClaim,
} from "./PersistentWorldRepository";

/**
 * Adapter boundary for a real email provider. Implementations must forward
 * `idempotencyKey` to the provider when possible because an external send and
 * the local acknowledgement cannot share a database transaction.
 */
export interface PersistentWorldEmailNotificationSink {
  send(message: {
    idempotencyKey: string;
    to: string;
    recipientDisplayName: string;
    kind: PersistentWorldNotificationKind;
    leadTimeMs: number | null;
    world: {
      id: string;
      name: string;
      startsAt: number;
    };
  }): Promise<void>;
}

export interface PersistentWorldNotificationWorkerOptions {
  emailSink: PersistentWorldEmailNotificationSink;
  now?: () => number;
  retryDelayMs?: (attemptCount: number) => number;
}

export interface PersistentWorldNotificationBatchResult {
  claimed: number;
  delivered: number;
  failed: number;
}

export class PersistentWorldNotificationWorker {
  private readonly now: () => number;
  private readonly retryDelayMs: (attemptCount: number) => number;

  constructor(
    private readonly repository: PersistentWorldRepository,
    private readonly options: PersistentWorldNotificationWorkerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs =
      options.retryDelayMs ??
      ((attemptCount) =>
        Math.min(60 * 60_000, 15_000 * 2 ** Math.min(8, attemptCount - 1)));
  }

  async runDueBatch(
    claimOptions: Omit<ClaimPersistentWorldNotificationsOptions, "now"> = {},
  ): Promise<PersistentWorldNotificationBatchResult> {
    const claims = this.repository.claimDueNotificationJobs({
      ...claimOptions,
      now: this.now(),
    });
    const result: PersistentWorldNotificationBatchResult = {
      claimed: claims.length,
      delivered: 0,
      failed: 0,
    };

    for (const claim of claims) {
      try {
        await this.dispatch(claim);
        this.repository.acknowledgeNotificationJob(
          claim.claimToken,
          this.now(),
        );
        result.delivered += 1;
      } catch (error) {
        result.failed += 1;
        try {
          this.repository.failNotificationJob(
            claim.claimToken,
            error,
            this.retryDelayMs(claim.job.attemptCount),
            this.now(),
          );
        } catch (leaseError) {
          // Cancellation or another worker reclaiming an expired lease wins.
          // Only swallow that expected race; surface storage failures.
          if (
            !(leaseError instanceof PersistentWorldRepositoryError) ||
            leaseError.code !== "LEASE_INVALID"
          ) {
            throw leaseError;
          }
        }
      }
    }
    return result;
  }

  private async dispatch(
    claim: PersistentWorldNotificationDispatchClaim,
  ): Promise<void> {
    if (claim.job.channel === "in_app") return;
    const to = claim.recipient.verifiedEmail;
    if (!to) {
      throw new Error(
        "Email notification was claimed without verified contact",
      );
    }
    await this.options.emailSink.send({
      idempotencyKey: claim.job.id,
      to,
      recipientDisplayName: claim.recipient.displayName,
      kind: claim.job.kind,
      leadTimeMs: claim.job.leadTimeMs,
      world: claim.world,
    });
  }
}
