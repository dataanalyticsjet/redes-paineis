type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean;
};

function decodeBasicCredentials(value: string) {
  if (!value.startsWith("Basic ")) return null;
  try {
    const decoded = atob(value.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function secretEquals(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(leftHash, rightHash);

  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function verifyUploadAuthorization(
  authorization: string | null,
  expectedUsername: string | undefined,
  expectedPassword: string | undefined,
) {
  if (!expectedUsername || !expectedPassword) return false;
  const credentials = authorization ? decodeBasicCredentials(authorization) : null;
  if (!credentials) return false;
  const [usernameMatches, passwordMatches] = await Promise.all([
    secretEquals(credentials.username, expectedUsername),
    secretEquals(credentials.password, expectedPassword),
  ]);
  return usernameMatches && passwordMatches;
}
