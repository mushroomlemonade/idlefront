import assert from "node:assert/strict";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { planWildernessAttackKernel } from "../../src/core/execution/planning/WildernessAttackKernel";
import type { WildernessAttackPlan } from "../../src/core/execution/planning/WildernessAttackPlanner";
import {
  planWildernessAttack,
  type WildernessAttackEffect,
} from "../../src/core/execution/planning/WildernessAttackPlanner";
import type { WildernessAttackInput } from "../../src/core/execution/planning/WildernessAttackState";
import { AttackImpl } from "../../src/core/game/AttackImpl";
import type { Game } from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import {
  TileMutationIndex,
  type TileMutationCheckpoint,
} from "../../src/server/simulation/TileMutationIndex";
import { captureWildernessDependencies } from "./WildernessShadowDependencies";

/** Diagnostic-only wrapper. The original tick is always the sole writer. */
export function installWildernessAttackShadow(
  game: Game,
  stride = 32,
  kernel = false,
  ahead = false,
  revisionChunkSize = 0,
  revisionComparisonSizes: number[] = [],
  applyPlans = false,
) {
  if (!Number.isSafeInteger(stride) || stride < 1)
    throw new Error("Bad shadow stride");
  if (revisionChunkSize && !ahead)
    throw new Error("Revision measurement requires ahead mode");
  if (applyPlans && !ahead)
    throw new Error("Plan application requires ahead mode");
  const revisions = revisionChunkSize
    ? new TileMutationIndex(game.map(), revisionChunkSize)
    : undefined;
  const comparisons = [...new Set(revisionComparisonSizes)]
    .filter((size) => size !== revisionChunkSize)
    .map((size) => ({
      index: new TileMutationIndex(game.map(), size),
      metrics: {
        chunkSize: size,
        bytes: 0,
        captureMs: 0,
        validationMs: 0,
        chunks: 0,
        valid: 0,
        falseConflicts: 0,
      },
    }));
  for (const item of comparisons) item.metrics.bytes = item.index.byteLength;
  const metrics = {
    implementation: kernel ? "kernel" : "guarded-reference",
    ahead,
    applyPlans,
    applied: 0,
    applicationMs: 0,
    stride,
    considered: 0,
    sampled: 0,
    verified: 0,
    ineligible: 0,
    fallbacks: {} as Record<string, number>,
    snapshotMs: 0,
    planningMs: 0,
    comparisonMs: 0,
    originalTickMs: 0,
    snapshotBytes: 0,
    maxReadTiles: 0,
    maxEffects: 0,
    conflicts: {} as Record<string, number>,
    dependencyCaptureMs: 0,
    dependencyValidationMs: 0,
    dependencyBytes: 0,
    preparedNotExecuted: 0,
    revisionChunkSize,
    revisionBytes: revisions?.byteLength ?? 0,
    revisionCaptureMs: 0,
    revisionValidationMs: 0,
    revisionChunks: 0,
    revisionFalseConflicts: 0,
    revisionValid: 0,
    checkpointCaptureMs: 0,
    checkpointValidationMs: 0,
    checkpointRejected: 0,
    checkpointFalseConflicts: 0,
    revisionComparisons: comparisons.map((item) => item.metrics),
  };
  type Prepared = {
    checkpoint: NonNullable<
      ReturnType<AttackExecution["wildernessPlanningCheckpoint"]>
    >;
    input: WildernessAttackInput;
    plan: Extract<WildernessAttackPlan, { kind: "shadow-plan" }>;
    dependencies: ReturnType<typeof captureWildernessDependencies>;
    revision?: TileMutationCheckpoint;
    comparisons: TileMutationCheckpoint[];
  };
  const prepared = new Map<AttackExecution, Prepared>();
  const makePlan = kernel ? planWildernessAttackKernel : planWildernessAttack;
  function prepare(
    execution: AttackExecution,
    tick: number,
  ): Prepared | undefined {
    const at = performance.now();
    const checkpoint = execution.wildernessPlanningCheckpoint(tick);
    const input = checkpoint?.input;
    metrics.snapshotMs += performance.now() - at;
    metrics.checkpointCaptureMs += performance.now() - at;
    metrics.sampled++;
    if (!input) {
      metrics.ineligible++;
      return;
    }
    metrics.snapshotBytes +=
      input.state.heap.priorities.byteLength +
      input.state.heap.tiles.byteLength +
      input.state.border.tiles.length * 4 +
      16;
    const started = performance.now();
    const plan = makePlan(input);
    metrics.planningMs += performance.now() - started;
    if (plan.kind === "fallback") {
      metrics.fallbacks[plan.reason] =
        (metrics.fallbacks[plan.reason] ?? 0) + 1;
      return;
    }
    const depStart = performance.now();
    const dependencies = captureWildernessDependencies(input, plan.readTiles);
    metrics.dependencyCaptureMs += performance.now() - depStart;
    metrics.dependencyBytes += dependencies.bytes;
    const revisionStarted = performance.now();
    const revision = revisions?.capture(plan.readTiles);
    metrics.revisionCaptureMs += performance.now() - revisionStarted;
    metrics.revisionChunks += revision?.chunks.length ?? 0;
    const comparisonCheckpoints = comparisons.map((item) => {
      const at = performance.now();
      const checkpoint = item.index.capture(plan.readTiles);
      item.metrics.captureMs += performance.now() - at;
      item.metrics.chunks += checkpoint.chunks.length;
      return checkpoint;
    });
    return {
      checkpoint: checkpoint!,
      input,
      plan,
      dependencies,
      revision,
      comparisons: comparisonCheckpoints,
    };
  }
  let recording: { id: string; effects: WildernessAttackEffect[] } | undefined;
  const originalTick = AttackExecution.prototype.tick;
  const originalGameTick = GameImpl.prototype.executeNextTick;
  if (ahead) {
    GameImpl.prototype.executeNextTick = function () {
      if (this !== game) return originalGameTick.call(this);
      prepared.clear();
      for (const execution of this.executions()) {
        if (
          !(execution instanceof AttackExecution) ||
          !execution.isActive() ||
          execution.targetID() !== this.terraNullius().id() ||
          ++metrics.considered % stride !== 0
        )
          continue;
        const result = prepare(execution, this.ticks());
        if (result) prepared.set(execution, result);
      }
      try {
        return originalGameTick.call(this);
      } finally {
        metrics.preparedNotExecuted += prepared.size;
        prepared.clear();
      }
    };
  }
  const add = AttackImpl.prototype.addBorderTile;
  const remove = AttackImpl.prototype.removeBorderTile;
  const setTroops = AttackImpl.prototype.setTroops;
  const unsubscribe = game.observeTerritory((tile) => {
    recording?.effects.push({ type: "conquer", tile });
  });
  AttackImpl.prototype.addBorderTile = function (tile) {
    if (recording?.id === this.id())
      recording.effects.push({ type: "border-add", tile });
    return add.call(this, tile);
  };
  AttackImpl.prototype.removeBorderTile = function (tile) {
    if (recording?.id === this.id())
      recording.effects.push({ type: "border-remove", tile });
    return remove.call(this, tile);
  };
  AttackImpl.prototype.setTroops = function (troops) {
    setTroops.call(this, troops);
    if (recording?.id === this.id())
      recording.effects.push({ type: "troops", troops: this.troops() });
  };
  AttackExecution.prototype.tick = function (tick) {
    if (ahead) {
      const pending = prepared.get(this);
      if (!pending) return originalTick.call(this, tick);
      prepared.delete(this);
      const validationStart = performance.now();
      const conflict = pending.dependencies.conflict(
        this.wildernessPlanningInput(tick),
      );
      metrics.dependencyValidationMs += performance.now() - validationStart;
      const checkpointStart = performance.now();
      const checkpointValid = pending.checkpoint.unchanged(tick);
      metrics.checkpointValidationMs += performance.now() - checkpointStart;
      assert(
        !(checkpointValid && conflict !== null && conflict !== "tile-state"),
        `Checkpoint missed ${conflict}`,
      );
      if (!checkpointValid) {
        metrics.checkpointRejected++;
        if (conflict === null) metrics.checkpointFalseConflicts++;
      }
      if (pending.revision) {
        const revisionStarted = performance.now();
        const unchanged = revisions!.unchanged(pending.revision);
        metrics.revisionValidationMs += performance.now() - revisionStarted;
        assert(
          !(unchanged && conflict === "tile-state"),
          "Mutation revision missed changed read tiles",
        );
        if (conflict === null) {
          if (unchanged) metrics.revisionValid++;
          else metrics.revisionFalseConflicts++;
        }
      }
      if (conflict) {
        checkComparisons(pending, conflict);
        metrics.conflicts[conflict] = (metrics.conflicts[conflict] ?? 0) + 1;
        return originalTick.call(this, tick);
      }
      checkComparisons(pending, conflict);
      if (
        applyPlans &&
        checkpointValid &&
        (!pending.revision || revisions!.unchanged(pending.revision))
      ) {
        const at = performance.now();
        const applied = this.tryApplyWildernessPlan(
          pending.checkpoint,
          pending.plan,
          tick,
          () =>
            pending.revision
              ? revisions!.unchanged(pending.revision)
              : conflict === null,
        );
        metrics.applicationMs += performance.now() - at;
        if (applied) {
          metrics.applied++;
          assert.deepEqual(
            this.wildernessPlanningInput(tick)?.state,
            pending.plan.state,
            `Applied state mismatch at ${tick}`,
          );
          return;
        }
      }
      return verify.call(this, tick, pending.input, pending.plan);
    }
    if (
      this.targetID() !== game.terraNullius().id() ||
      ++metrics.considered % stride !== 0
    )
      return originalTick.call(this, tick);
    const snapshotStart = performance.now();
    const input = this.wildernessPlanningInput(tick);
    metrics.snapshotMs += performance.now() - snapshotStart;
    metrics.sampled++;
    if (!input) {
      metrics.ineligible++;
      return originalTick.call(this, tick);
    }
    metrics.snapshotBytes +=
      input.state.heap.priorities.byteLength +
      input.state.heap.tiles.byteLength +
      input.state.border.tiles.length * 4 +
      16;
    const planningStart = performance.now();
    const plan = makePlan(input);
    metrics.planningMs += performance.now() - planningStart;
    if (plan.kind === "fallback") {
      metrics.fallbacks[plan.reason] =
        (metrics.fallbacks[plan.reason] ?? 0) + 1;
      return originalTick.call(this, tick);
    }
    return verify.call(this, tick, input, plan);
  };
  function checkComparisons(pending: Prepared, conflict: string | null) {
    comparisons.forEach((item, i) => {
      const at = performance.now();
      const unchanged = item.index.unchanged(pending.comparisons[i]);
      item.metrics.validationMs += performance.now() - at;
      assert(
        !(unchanged && conflict === "tile-state"),
        `Chunk ${item.metrics.chunkSize} missed changed read tiles`,
      );
      if (conflict === null) {
        if (unchanged) item.metrics.valid++;
        else item.metrics.falseConflicts++;
      }
    });
  }
  function verify(
    this: AttackExecution,
    tick: number,
    input: WildernessAttackInput,
    plan: Extract<WildernessAttackPlan, { kind: "shadow-plan" }>,
  ) {
    const actual: WildernessAttackEffect[] = [];
    recording = { id: input.state.attackID, effects: actual };
    const originalStart = performance.now();
    try {
      originalTick.call(this, tick);
    } finally {
      recording = undefined;
      metrics.originalTickMs += performance.now() - originalStart;
    }
    const compareStart = performance.now();
    const after = this.wildernessPlanningInput(tick);
    const context = `shadow mismatch tick=${tick} attack=${input.state.attackID}`;
    assert.deepEqual(actual, plan.effects, `${context} effects`);
    assert.deepEqual(after?.state, plan.state, `${context} state`);
    metrics.comparisonMs += performance.now() - compareStart;
    metrics.verified++;
    metrics.maxReadTiles = Math.max(
      metrics.maxReadTiles,
      plan.readTiles.length,
    );
    metrics.maxEffects = Math.max(metrics.maxEffects, plan.effects.length);
  }
  return {
    metrics,
    dispose() {
      revisions?.dispose();
      for (const item of comparisons) item.index.dispose();
      AttackExecution.prototype.tick = originalTick;
      if (ahead) GameImpl.prototype.executeNextTick = originalGameTick;
      AttackImpl.prototype.addBorderTile = add;
      AttackImpl.prototype.removeBorderTile = remove;
      AttackImpl.prototype.setTroops = setTroops;
      unsubscribe();
    },
  };
}
