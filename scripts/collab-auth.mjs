export const CLOSE_POLICY_VIOLATION = 1008;

export function authenticateCollabRequestParams(params, expectedToken) {
  const roomId = params.get('roomId') || '';
  const userId = params.get('userId') || '';
  const token = params.get('token') || '';

  if (!expectedToken) {
    return { ok: false, reason: 'server auth token is not configured' };
  }
  if (!token || token !== expectedToken) {
    return { ok: false, reason: 'invalid collaboration token' };
  }
  if (!roomId || !userId) {
    return { ok: false, reason: 'roomId and userId are required' };
  }

  return { ok: true, roomId, userId };
}

export function isCollabMessageAuthorized(auth, msg) {
  return !!(
    auth &&
    msg &&
    auth.roomId === msg.roomId &&
    auth.userId === msg.userId
  );
}
