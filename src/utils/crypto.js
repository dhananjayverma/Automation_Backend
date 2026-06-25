const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function getEncryptionKey() {
  const secret = process.env.WEBHOOK_SECRET || "default-secret-key-at-least-32-chars-long!";
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypts cleartext using AES-256-GCM.
 * Returns string formatted as ivHex:encryptedHex:tagHex
 */
function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const tag = cipher.getAuthTag().toString("hex");
  
  return `${iv.toString("hex")}:${encrypted}:${tag}`;
}

/**
 * Decrypts text formatted as ivHex:encryptedHex:tagHex
 */
function decrypt(encryptedText) {
  if (!encryptedText) return "";
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) {
      // Fallback if the password is not encrypted (e.g. legacy data)
      return encryptedText;
    }
    
    const [ivHex, encrypted, tagHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const key = getEncryptionKey();
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    // If decryption fails, return the original text as fallback
    return encryptedText;
  }
}

module.exports = { encrypt, decrypt };
