/**
 * 单元格批注插件：提供本地线程 API，并在实时协同插件存在时同步线程。
 */
export class CellCommentPlugin {
  name = 'CellComment';
  version = '1.0.0';
  description = '单元格批注与讨论线程';
  dependencies = [];

  constructor(options = {}) {
    this.userId = options.userId || 'local';
    this.userName = options.userName || '我';
    this.userColor = options.userColor || '#2563eb';
    this._workbook = null;
    this._registry = null;
    this._unsubComment = null;
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
    registry.setSharedState('comments:get', () => workbook.getComments());
    registry.setSharedState('comments:getForCell', (r, c) => workbook.getComments().filter(comment => comment.r === r && comment.c === c));
    registry.setSharedState('comments:add', (r, c, text) => this.addComment(r, c, text));
    registry.setSharedState('comments:reply', (id, text) => this.replyComment(id, text));
    registry.setSharedState('comments:update', (id, patch) => workbook.updateComment(id, patch));
    registry.setSharedState('comments:remove', id => workbook.removeComment(id));
  }

  onMounted(workbook) {
    this._workbook = workbook;
    this._unsubComment = workbook.on('comment-change', payload => {
      if (payload?.remote || !payload?.comment) return;
      if (this._registry?.getSharedState('collaboration:comment-sync-owner')) return;
      const collaboration = this._registry?.get('RealtimeCollaboration');
      collaboration?.broadcastComment(payload.comment, payload.action);
    });
  }

  onUnmount() {
    this._unsubComment?.();
    this._unsubComment = null;
    for (const key of ['comments:get', 'comments:getForCell', 'comments:add', 'comments:reply', 'comments:update', 'comments:remove']) {
      this._registry?.deleteSharedState(key);
    }
  }

  _author() {
    const getUserInfo = this._registry?.getSharedState('collaboration:getUserInfo');
    const collaborationUser = typeof getUserInfo === 'function' ? getUserInfo() : null;
    return {
      userId: collaborationUser?.userId || this.userId,
      userName: collaborationUser?.userName || this.userName,
      userColor: collaborationUser?.userColor || this.userColor
    };
  }

  addComment(r, c, text) {
    return this._workbook?.addComment(r, c, text, this._author()) || null;
  }

  replyComment(id, text) {
    return this._workbook?.replyComment(id, text, this._author()) || null;
  }
}

export function createCellCommentPlugin(options = {}) {
  return new CellCommentPlugin(options);
}
