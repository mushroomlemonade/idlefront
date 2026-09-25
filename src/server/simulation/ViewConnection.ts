import WebSocket from "ws";

interface Frame {
  packets: Array<Uint8Array | undefined>;
  index: number;
  tick: number;
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
  constructor(
    private ws: WebSocket,
    private onSlow: () => void,
    private onSnapshotAcknowledged: () => void = () => undefined,
  ) {}
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * A snapshot is one immutable, finite map image, not a backlog of live ticks.
   * Drain it through the same eight-frame ACK window without inserting all of
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
    const size = packets.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    if (
      this.queue.length >= 1_024 ||
      packets.length > 16_384 ||
      this.queuedBytes + size > 128 * 1024 * 1024
    ) {
      this.stop();
      this.onSlow();
      return;
    }
    // Own the outer list: other players/devices may share immutable buffers.
    this.queue.push({ packets: [...packets], index: 0, tick });
    this.queuedBytes += size;
    this.pump();
  }
  acknowledge(sequence: number): void {
    if (sequence <= this.acknowledged || sequence > this.sequence) return;
    clearTimeout(this.ackTimeout);
    this.ackTimeout = undefined;
    this.acknowledged = sequence;
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
    while (this.sequence - this.acknowledged < 8) {
      let bytes: Uint8Array;
      let finalSnapshotFrame = false;
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
      if (finalSnapshotFrame) this.snapshotFinalSequence = this.sequence;
      this.ws.send(
        Buffer.concat([header, bytes]),
        { binary: true },
        (error) => {
          if (error) {
            this.stop();
            this.onSlow();
          }
        },
      );
      if (this.closed) return;
    }
    if (this.sequence > this.acknowledged && this.ackTimeout === undefined) {
      this.ackTimeout = setTimeout(() => {
        this.stop();
        this.onSlow();
      }, 30_000);
      this.ackTimeout.unref?.();
    }
  }
  stop(): void {
    this.closed = true;
    clearTimeout(this.ackTimeout);
    this.queue = [];
    this.queuedBytes = 0;
    this.snapshot = null;
  }
}
