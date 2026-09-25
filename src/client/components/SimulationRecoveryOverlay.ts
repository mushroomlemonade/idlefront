import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ServerSimulationRecoveryMessage } from "../../core/Schemas";

export function formatRecoveryDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60)
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h ${minuteRemainder}m`;
}

@customElement("simulation-recovery-overlay")
export class SimulationRecoveryOverlay extends LitElement {
  @state() private progress: ServerSimulationRecoveryMessage | null = null;
  private samples: Array<{ completed: number; elapsedMs: number }> = [];

  private readonly onProgress = (event: Event) => {
    const progress = (event as CustomEvent<ServerSimulationRecoveryMessage>)
      .detail;
    if (!progress || progress.totalTurns <= 0) return;
    this.progress = progress;
    if (progress.status === "replaying") {
      this.samples.push({
        completed: progress.completedTurns,
        elapsedMs: progress.elapsedMs,
      });
      if (this.samples.length > 12) this.samples.shift();
    }
  };

  private readonly onViewLive = () => {
    this.progress = null;
    this.samples = [];
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("idlefront:simulation-recovery", this.onProgress);
    window.addEventListener("idlefront:simulation-view-live", this.onViewLive);
  }

  disconnectedCallback(): void {
    window.removeEventListener(
      "idlefront:simulation-recovery",
      this.onProgress,
    );
    window.removeEventListener(
      "idlefront:simulation-view-live",
      this.onViewLive,
    );
    super.disconnectedCallback();
  }

  createRenderRoot() {
    return this;
  }

  private estimatedRemainingMs(): number | null {
    const progress = this.progress;
    if (!progress || progress.status === "ready") return 0;
    const remaining = progress.totalTurns - progress.completedTurns;
    if (remaining <= 0) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const recentTurns = last && first ? last.completed - first.completed : 0;
    const recentMs = last && first ? last.elapsedMs - first.elapsedMs : 0;
    if (recentTurns > 0 && recentMs >= 1_000)
      return (remaining * recentMs) / recentTurns;
    if (progress.completedTurns >= 100 && progress.elapsedMs >= 1_000)
      return (remaining * progress.elapsedMs) / progress.completedTurns;
    return null;
  }

  render() {
    const progress = this.progress;
    if (!progress) return null;
    const percent = Math.min(
      100,
      Math.max(0, (progress.completedTurns / progress.totalTurns) * 100),
    );
    const remainingMs = this.estimatedRemainingMs();
    const ready = progress.status === "ready";
    return html`
      <div
        class="fixed inset-0 z-[9997] flex items-center justify-center bg-black/55 px-5 backdrop-blur-[3px]"
        style="padding-top: max(1.25rem, env(safe-area-inset-top)); padding-bottom: max(1.25rem, env(safe-area-inset-bottom));"
        role="status"
        aria-live="polite"
        aria-label="Restoring world"
      >
        <section
          class="w-full max-w-[28rem] overflow-hidden rounded-[1.15rem] border border-amber-200/35 bg-[#100e0c]/95 p-5 text-[#f5efe2] shadow-[0_18px_70px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.12)] sm:p-6"
        >
          <p
            class="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.2em] text-amber-200/70"
          >
            ${ready ? "World restored" : "Restoring world"}
          </p>
          <h2
            class="m-0 text-xl font-semibold tracking-tight text-white sm:text-2xl"
          >
            ${ready ? "Opening the map…" : "Replaying saved turns…"}
          </h2>
          <div
            class="relative mt-5 h-3 overflow-hidden rounded-full border border-white/15 bg-black/65 shadow-[inset_0_2px_4px_rgba(0,0,0,0.9)]"
            aria-hidden="true"
          >
            <div
              class="h-full rounded-full bg-[linear-gradient(180deg,#fff1ad_0%,#dca632_42%,#87520b_100%)] shadow-[0_0_16px_rgba(245,190,70,0.55),inset_0_1px_0_rgba(255,255,255,0.85)] transition-[width] duration-300 ease-out"
              style="width: ${percent}%"
            ></div>
          </div>
          <div
            class="mt-3 flex items-baseline justify-between gap-4 tabular-nums"
          >
            <strong class="text-lg text-white">${Math.floor(percent)}%</strong>
            <span class="text-right text-xs text-white/65 sm:text-sm">
              ${progress.completedTurns.toLocaleString()} of
              ${progress.totalTurns.toLocaleString()} turns
            </span>
          </div>
          <p class="mb-0 mt-3 text-sm text-white/70">
            ${
              ready
                ? "Replay complete. Preparing your live view."
                : remainingMs === null
                  ? "Measuring replay speed…"
                  : `About ${formatRecoveryDuration(remainingMs)} remaining`
            }
          </p>
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "simulation-recovery-overlay": SimulationRecoveryOverlay;
  }
}
