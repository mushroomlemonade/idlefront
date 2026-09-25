import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "crypto";

export function hashWorldPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export async function matchesWorldPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [salt, hash] = encoded.split(":");
  if (!salt || !hash || hash.length !== 64) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
