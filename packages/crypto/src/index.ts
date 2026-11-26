const encoder=new TextEncoder();const decoder=new TextDecoder();
function toBase64(bytes:Uint8Array){let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)}
function fromBase64(value:string){return Uint8Array.from(atob(value),(char)=>char.charCodeAt(0))}
export interface EncryptedSecret{version:1;iv:string;ciphertext:string}
export async function importMasterKey(base64Key:string){const raw=fromBase64(base64Key);if(raw.byteLength!==32)throw new Error("MASTER_ENCRYPTION_KEY must decode to 32 bytes");return crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt","decrypt"])}
export async function encryptSecret(value:string,base64Key:string):Promise<EncryptedSecret>{const key=await importMasterKey(base64Key);const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(value));return{version:1,iv:toBase64(iv),ciphertext:toBase64(new Uint8Array(encrypted))}}
export async function decryptSecret(payload:EncryptedSecret,base64Key:string){const key=await importMasterKey(base64Key);const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64(payload.iv)},key,fromBase64(payload.ciphertext));return decoder.decode(decrypted)}
export async function hmacHex(value:string,secret:string){const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signature=await crypto.subtle.sign("HMAC",key,encoder.encode(value));return[...new Uint8Array(signature)].map((byte)=>byte.toString(16).padStart(2,"0")).join("")}
