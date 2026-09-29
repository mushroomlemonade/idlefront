import type { HistorySnapshot } from "./LeaderboardHistory";

/** Device-local observed history. Two worlds at most; no synchronous multi-MB
 * localStorage writes on the rendering thread, and no server/fog expansion. */
export class LeaderboardHistoryStore {
  private db?: Promise<IDBDatabase | null>;
  private open(): Promise<IDBDatabase | null> {
    return (this.db ??= new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open("idlefront-observed-history", 1);
      request.onupgradeneeded = () =>
        request.result
          .createObjectStore("worlds", { keyPath: "key" })
          .createIndex("savedAt", "savedAt");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    }));
  }
  async load(key: string): Promise<HistorySnapshot | null> {
    try {
      const db = await this.open();
      if (!db) return null;
      return await new Promise((resolve) => {
        const request = db
          .transaction("worlds", "readonly")
          .objectStore("worlds")
          .get(key);
        request.onsuccess = () => resolve(request.result?.snapshot ?? null);
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }
  async save(key: string, snapshot: HistorySnapshot): Promise<void> {
    if (!Number.isFinite(snapshot.tick) || !snapshot.series.length) return;
    try {
      const db = await this.open();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction("worlds", "readwrite"),
          store = tx.objectStore("worlds");
        store.put({ key, savedAt: Date.now(), snapshot });
        const request = store.index("savedAt").openKeyCursor(null, "prev");
        let count = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (++count > 2) store.delete(cursor.primaryKey);
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      /* Private browsing/quota failure must never affect the match. */
    }
  }
}
