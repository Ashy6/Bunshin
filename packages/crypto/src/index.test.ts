import { describe,expect,it } from "vitest";
import { decryptSecret,encryptSecret } from "./index";
describe("secret encryption",()=>{it("round trips with AES-GCM",async()=>{const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));const encrypted=await encryptSecret("sk-example",key);expect(encrypted.ciphertext).not.toContain("sk-example");await expect(decryptSecret(encrypted,key)).resolves.toBe("sk-example")})});
