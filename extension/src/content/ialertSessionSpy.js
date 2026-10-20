/**
 * iALERT Session Spy (MAIN World, document_start)
 * ───────────────────────────────────────────────
 * Wraps crypto.subtle.decrypt to intercept the iALERT SPA's decrypted
 * responses. These contain auth tokens (login response) or refreshed tokens
 * (refresh-token response).
 *
 * IMPORTANT: Never log any intercepted data; return the original decrypt
 * result unchanged.
 */

const IALERT_ORIGIN = 'https://ialert.ashokleyland.com';

// Store the original decrypt function
const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);

/**
 * Check if a string looks like JSON and contains token data
 */
function looksLikeIALERTLogin(str) {
  try {
    const parsed = JSON.parse(str);
    return (
      parsed &&
      parsed.data &&
      typeof parsed.data.token === 'string' &&
      typeof parsed.data.token_value === 'string' &&
      typeof parsed.data.user_id === 'number'
    );
  } catch {
    return false;
  }
}

/**
 * Check if a string looks like a refresh response (no token_value)
 */
function looksLikeIALERTRotate(str) {
  try {
    const parsed = JSON.parse(str);
    return (
      parsed &&
      parsed.data &&
      typeof parsed.data.token === 'string' &&
      typeof parsed.data.refresh_token === 'string' &&
      !parsed.data.token_value
    );
  } catch {
    return false;
  }
}

/**
 * Send message to the isolated world reader
 */
function postToReader(msg) {
  // Use postMessage to the isolated world script
  // The isolated world script listens on the same origin
  window.postMessage(msg, IALERT_ORIGIN);
}

// Wrap crypto.subtle.decrypt
crypto.subtle.decrypt = async function (algorithm, key, data) {
  // The page's own decrypt runs exactly once; its errors reach the page
  // unchanged. Only the inspection below is guarded.
  const result = await originalDecrypt(algorithm, key, data);
  try {
    const decoder = new TextDecoder();
    const decryptedText = decoder.decode(result);

    // Check for login response (has token_value, user_id)
    if (looksLikeIALERTLogin(decryptedText)) {
      const parsed = JSON.parse(decryptedText);
      const { token, refresh_token, token_value, user_id, owner_id } = parsed.data;

      postToReader({
        type: 'IALERT_SESSION',
        token,
        refreshToken: refresh_token || null,
        tokenValue: String(token_value),
        ialertUserId: String(user_id),
        ialertOwnerId: String(owner_id ?? user_id),
      });
    }
    // Check for refresh response (no token_value, has refresh_token)
    else if (looksLikeIALERTRotate(decryptedText)) {
      const parsed = JSON.parse(decryptedText);
      const { token, refresh_token } = parsed.data;

      postToReader({
        type: 'IALERT_ROTATED',
        token,
        refreshToken: refresh_token,
      });
    }
    // Not iALERT token data - ignore silently
  } catch {
    // Inspection failed: ignore silently, the page still gets its result.
  }
  return result;
};
