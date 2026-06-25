const assert = require("node:assert/strict");
const test = require("node:test");
const { encrypt, decrypt } = require("../src/utils/crypto");

test("crypto encrypts and decrypts correctly", () => {
  const original = "mySecretPassword123!";
  const encrypted = encrypt(original);
  
  assert.notEqual(original, encrypted);
  assert.match(encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  
  const decrypted = decrypt(encrypted);
  assert.equal(decrypted, original);
});

test("crypto handles plain text fallback if not encrypted", () => {
  const plain = "already_plain_text";
  const decrypted = decrypt(plain);
  assert.equal(decrypted, plain);
});

test("crypto handles empty strings gracefully", () => {
  assert.equal(encrypt(""), "");
  assert.equal(decrypt(""), "");
});
