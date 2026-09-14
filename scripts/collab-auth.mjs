export const CLOSE_POLICY_VIOLATION = 1008;

export function authenticateCollabRequestParams(params, expectedToken, expectedEditToken = '') {
  const roomId = params.get('roomId') || '';
  const userId = params.get('userId') || '';
  const token = params.get('token') || '';

  if (expectedToken) {
    if (!token || token !== expectedToken) {
      return { ok: false, reason: 'invalid collaboration token' };
    }
  } else if (token) {
    return { ok: false, reason: 'server auth token is not configured' };
  }
  if (!roomId || !userId) {
    return { ok: false, reason: 'roomId and userId are required' };
  }

  const readOnly = expectedEditToken
    ? params.get('editToken') !== expectedEditToken
    : params.get('readOnly') === 'true';

  return { ok: true, roomId, userId, readOnly };
}

export function isCollabMessageAuthorized(auth, msg) {
  return !!(
    auth &&
    msg &&
    auth.roomId === msg.roomId &&
    auth.userId === msg.userId
  );
}
