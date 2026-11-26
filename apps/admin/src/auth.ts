const encoder = new TextEncoder();
// Keep first-run and login within Cloudflare Workers CPU limits. The encoded
// hash stores its own iteration count so this can be raised with rehashing later.
const ITERATIONS = 100_000;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations = ITERATIONS,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  return `pbkdf2-sha256$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterations, salt, expected] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256" || !iterations || !salt || !expected)
    return false;
  const actual = await derive(
    password,
    base64ToBytes(salt),
    Number(iterations),
  );
  const expectedBytes = base64ToBytes(expected);
  if (actual.length !== expectedBytes.length) return false;
  let different = 0;
  for (let i = 0; i < actual.length; i++)
    different |= actual[i]! ^ expectedBytes[i]!;
  return different === 0;
}

export function randomToken() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const item of header.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
export function sessionCookie(
  token: string,
  secure: boolean,
  maxAge = 60 * 60 * 24 * 7,
) {
  return `bunshin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function clearSessionCookie() {
  return "bunshin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}
