const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * @param {string} value
 */
export function decodeBase64UrlAsUtf8(value) {
  if (value.length % 4 === 1) {
    throw new Error("Invalid base64url value.");
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }

  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error("Invalid UTF-8 source data.", { cause: error });
  }
}