import { createHash } from "node:crypto";
import { PersistentIdSchema } from "../core/Schemas";
/** Archive-only pseudonym for restored/offline seats. Never changes authority,
 * authentication or gameplay identity; never writes a guest token to a replay. */
export function archiveIdentity(
  value: string | undefined,
  gameID: string,
  clientID: string,
): string {
  if (value && PersistentIdSchema.safeParse(value).success) return value;
  const hash = createHash("sha256")
    .update(`idlefront-replay-seat-v1:${gameID}:${clientID}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
