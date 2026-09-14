import { describe, expect, it } from 'vitest';
import {
  CLOSE_POLICY_VIOLATION,
  authenticateCollabRequestParams,
  isCollabMessageAuthorized
} from '../../scripts/collab-auth.mjs';

function params(query) {
  return new URLSearchParams(query);
}

describe('collab-server WebSocket 鉴权', () => {
  it('缺失或错误 token 的握手会被判定为未授权', () => {
    expect(CLOSE_POLICY_VIOLATION).toBe(1008);

    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me'),
        'valid-token'
      )
    ).toEqual({ ok: false, reason: 'invalid collaboration token' });

    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me&token=bad-token'),
        'valid-token'
      )
    ).toEqual({ ok: false, reason: 'invalid collaboration token' });

    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me&token=valid-token'),
        ''
      )
    ).toEqual({ ok: false, reason: 'server auth token is not configured' });
  });

  it('合法 token 必须同时绑定 roomId 和 userId', () => {
    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me&token=valid-token'),
        'valid-token'
      )
    ).toEqual({ ok: true, roomId: 'room-1', userId: 'me', readOnly: false });

    expect(
      authenticateCollabRequestParams(
        params('userId=me&token=valid-token'),
        'valid-token'
      )
    ).toEqual({ ok: false, reason: 'roomId and userId are required' });
  });

  it('编辑权限由服务端令牌决定，未持有编辑令牌的连接为只读', () => {
    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me&token=valid-token&editToken=edit-secret'),
        'valid-token',
        'edit-secret'
      )
    ).toEqual({
      ok: true,
      roomId: 'room-1',
      userId: 'me',
      readOnly: false
    });

    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me&token=valid-token'),
        'valid-token',
        'edit-secret'
      )
    ).toEqual({
      ok: true,
      roomId: 'room-1',
      userId: 'me',
      readOnly: true
    });

    expect(
      authenticateCollabRequestParams(
        params('roomId=room-1&userId=me&readOnly=true'),
        ''
      )
    ).toEqual({
      ok: true,
      roomId: 'room-1',
      userId: 'me',
      readOnly: true
    });
  });

  it('已认证连接不能在消息中冒用其它 roomId 或 userId', () => {
    const auth = { roomId: 'room-1', userId: 'me' };

    expect(isCollabMessageAuthorized(auth, {
      type: 'user-join',
      roomId: 'room-1',
      userId: 'me'
    })).toBe(true);

    expect(isCollabMessageAuthorized(auth, {
      type: 'user-join',
      roomId: 'room-1',
      userId: 'attacker'
    })).toBe(false);

    expect(isCollabMessageAuthorized(auth, {
      type: 'cell-change',
      roomId: 'other-room',
      userId: 'me'
    })).toBe(false);
  });
});
