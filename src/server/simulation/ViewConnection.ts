import WebSocket from "ws";

interface Frame {
  packets: Array<Uint8Array | undefined>;
  index: number;
  tick: number;
  compactedTicks?: number;
}
export interface ViewDeliveryFailure {
  reason:
    | "queue-bytes"
    | "queue-frames"
    | "packet-count"
    | "ack-timeout"
    | "send-error";
  queuedBytes: number;
  queuedFrames: number;
  inFlightBytes: number;
  inFlightPackets: number;
  snapshotRemaining: number;
  acknowledged: number;
  sequence: number;
}
/** Bounded application-acknowledged window. RTT never gates one game tick. */
export class ViewConnection {
  private queue: Frame[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private acknowledged = 0;
  private closed = false;
  private ackTimeout: ReturnType<typeof setTimeout> | undefined;
  private snapshot: Array<Uint8Array | undefined> | null = null;
  private snapshotIndex = 0;
  private snapshotFinalSequence: number | undefined;
  private snapshotAcknowledged = false;
  private inFlight = new Map<number, number>();
  private inFlightBytes = 0;
  private compactedFrames = 0;
  private savedBytes = 0;
  private peakQueuedBytes = 0;
  constructor(
    private ws: WebSocket,
    private onSlow: (failure: ViewDeliveryFailure) => void,
    private onSnapshotAcknowledged: () => void = () => undefined,
    private compactState?: (
      older: Uint8Array,
      newer: Uint8Array,
    ) => Uint8Array | undefined,
  ) {}
  get isClosed(): boolean {
    return this.closed;
  }
  diagnostics() {
    return {
      queuedBytes: this.queuedBytes,
      queuedFrames: this.queue.length,
      peakQueuedBytes: this.peakQueuedBytes,
      inFlightBytes: this.inFlightBytes,
      compactedFrames: this.compactedFrames,
      savedBytes: this.savedBytes,
      oldestQueuedTick: this.queue[0]?.tick,
    };
  }

  /**
   * A snapshot is one immutable, finite map image, not a backlog of live ticks.
   * Drain it through a byte-bounded snapshot ACK window without inserting all of
   * its chunks into the bounded live queue. Release each consumed reference.
   * This avoids rejecting healthy joins as soon as a larger map exceeds 1,024
   * snapshot chunks. Live updates retain their existing bounds and deadline.
   */
  startSnapshot(packets: Uint8Array[]): void {
    if (this.closed) return;
    if (this.sequence !== 0 || this.snapshot !== null || this.queue.length)
      throw new Error("Snapshot must be the first view on a fresh connection");
    this.snapshot = packets;
    this.snapshotIndex = 0;
    this.pump();
  }
  enqueue(bytes: Uint8Array, tick: number): void {
    this.enqueueBatch([bytes], tick);
  }
  /** A bounded logical update may contain many mobile-sized reveal fragments. */
  enqueueBatch(packets: readonly Uint8Array[], tick: number): void {
    if (this.closed) return;
    if (!packets.length) return;
    const tail = this.queue[this.queue.length - 1];
    // Only entirely unsent single-packet live states can be replaced. Never
    // modify a snapshot, fragmented fog reveal, in-flight data or shared buffer.
    if (
      this.compactState &&
      this.queue.length >= 4 &&
      packets.length === 1 &&
      tail?.index === 0 &&
      tail.packets.length === 1 &&
      (tail.compactedTicks ?? 1) < 10
    ) {
      const older = tail.packets[0]!;
      const merged = this.compactState(older, packets[0]);
      if (
        merged &&
        this.queuedBytes + merged.byteLength - older.byteLength <=
          128 * 1024 * 1024
      ) {
        this.queuedBytes += merged.byteLength - older.byteLength;
        this.compactedFrames++;
        this.savedBytes +=
          older.byteLength + packets[0].byteLength - merged.byteLength;
        tail.packets = [merged];
        tail.tick = tick;
        tail.compactedTicks = (tail.compactedTicks ?? 1) + 1;
        this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
        this.pump();
        return;
      }
    }
    const size = packets.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    if (
      this.queue.length >= 1_024 ||
      packets.length > 16_384 ||
      this.queuedBytes + size > 128 * 1024 * 1024
    ) {
      this.fail(
        this.queuedBytes + size > 128 * 1024 * 1024
          ? "queue-bytes"
          : packets.length > 16_384
            ? "packet-count"
            : "queue-frames",
      );
      return;
    }
    // Own the outer list: other players/devices may share immutable buffers.
    this.queue.push({ packets: [...packets], index: 0, tick });
    this.queuedBytes += size;
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
    this.pump();
  }
  acknowledge(sequence: number): void {
    if (this.closed) return;
    if (sequence <= this.acknowledged || sequence > this.sequence) return;
    clearTimeout(this.ackTimeout);
    this.ackTimeout = undefined;
    this.acknowledged = sequence;
    for (const [id, bytes] of this.inFlight) {
      if (id > sequence) break;
      this.inFlightBytes -= bytes;
      this.inFlight.delete(id);
    }
    if (
      !this.snapshotAcknowledged &&
      this.snapshotFinalSequence !== undefined &&
      this.acknowledged >= this.snapshotFinalSequence
    ) {
      this.snapshotAcknowledged = true;
      this.onSnapshotAcknowledged();
    }
    this.pump();
  }
  private pump(): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    // A packet-count-only window throttles thousands of tiny snapshot chunks.
    // Bound snapshot delivery by BOTH bytes and packets; live window stays 8.
    const snapshotLoading =
      !this.snapshotAcknowledged &&
      (this.snapshot !== null || this.snapshotFinalSequence !== undefined);
    while (this.sequence - this.acknowledged < (snapshotLoading ? 64 : 8)) {
      let bytes: Uint8Array;
      let finalSnapshotFrame = false;
      const next =
        this.snapshot?.[this.snapshotIndex] ??
        this.queue[0]?.packets[this.queue[0].index];
      if (!next) break;
      // One oversized native frame proceeds alone, avoiding byte-cap deadlock.
      if (
        snapshotLoading &&
        this.inFlight.size &&
        this.inFlightBytes + next.byteLength + 4 > 2 * 1024 * 1024
      )
        break;
      if (this.snapshot && this.snapshotIndex < this.snapshot.length) {
        bytes = this.snapshot[this.snapshotIndex]!;
        this.snapshot[this.snapshotIndex++] = undefined;
        if (this.snapshotIndex === this.snapshot.length) {
          finalSnapshotFrame = true;
          this.snapshot = null;
        }
      } else {
        const frame = this.queue[0];
        if (!frame) break;
        bytes = frame.packets[frame.index]!;
        frame.packets[frame.index++] = undefined;
        if (frame.index === frame.packets.length) this.queue.shift();
        this.queuedBytes -= bytes.byteLength;
      }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(++this.sequence);
      this.inFlight.set(this.sequence, bytes.byteLength + 4);
      this.inFlightBytes += bytes.byteLength + 4;
      if (finalSnapshotFrame) this.snapshotFinalSequence = this.sequence;
      this.ws.send(
        Buffer.concat([header, bytes]),
        { binary: true },
        (error) => {
          if (error) {
            this.fail("send-error");
          }
        },
      );
      if (this.closed) return;
    }
    if (this.sequence > this.acknowledged && this.ackTimeout === undefined) {
      this.ackTimeout = setTimeout(() => {
        this.fail("ack-timeout");
      }, 30_000);
      this.ackTimeout.unref?.();
    }
  }
  private fail(reason: ViewDeliveryFailure["reason"]): void {
    if (this.closed) return;
    const failure: ViewDeliveryFailure = {
      reason,
      queuedBytes: this.queuedBytes,
      queuedFrames: this.queue.length,
      inFlightBytes: this.inFlightBytes,
      inFlightPackets: this.inFlight.size,
      snapshotRemaining: this.snapshot
        ? this.snapshot.length - this.snapshotIndex
        : 0,
      acknowledged: this.acknowledged,
      sequence: this.sequence,
    };
    this.stop();
    this.onSlow(failure);
  }
  stop(): void {
    this.closed = true;
    clearTimeout(this.ackTimeout);
    this.queue = [];
    this.queuedBytes = 0;
    this.snapshot = null;
    this.inFlight.clear();
    this.inFlightBytes = 0;
  }
}
