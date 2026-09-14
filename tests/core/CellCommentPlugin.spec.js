import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '@/core/Workbook';
import { CellCommentPlugin } from '@/plugins/CellCommentPlugin';
import { CollaborativeCursorPlugin } from '@/plugins/CollaborativeCursorPlugin';
import { RealtimeCollaborationPlugin } from '@/plugins/RealtimeCollaborationPlugin';

describe('Workbook 单元格批注', () => {
  it('支持新增、回复、解决、删除并发出变更事件', () => {
    const workbook = new Workbook({ enableWasm: false });
    const changes = [];
    workbook.on('comment-change', payload => changes.push(payload));

    const comment = workbook.addComment(1, 2, '请确认这个数字', {
      userId: 'u1', userName: '张三', userColor: '#f00'
    });
    expect(comment.messages).toHaveLength(1);
    expect(comment.messages[0].authorName).toBe('张三');

    const replied = workbook.replyComment(comment.id, '已经核对完成', {
      userId: 'u2', userName: '李四'
    });
    expect(replied.messages).toHaveLength(2);

    const resolved = workbook.updateComment(comment.id, { resolved: true });
    expect(resolved.resolved).toBe(true);
    expect(workbook.removeComment(comment.id)).toBe(true);
    expect(workbook.getComments()).toEqual([]);
    expect(changes.map(item => item.action)).toEqual(['add', 'reply', 'update', 'remove']);

    workbook.destroy();
  });

  it('批注随行列插入和删除移动或移除', () => {
    const workbook = new Workbook({ enableWasm: false });
    const first = workbook.addComment(2, 3, '行列结构测试');
    workbook.sheetStructure.insertRow(1);
    expect(workbook.getComment(first.id).r).toBe(3);
    workbook.sheetStructure.insertColumn(2);
    expect(workbook.getComment(first.id).c).toBe(4);
    workbook.sheetStructure.deleteRow(3);
    expect(workbook.getComment(first.id)).toBeNull();
    workbook.destroy();
  });

  it('toJSON/fromJSON 和多工作表切换保留批注线程', () => {
    const workbook = new Workbook({ enableWasm: false });
    const comment = workbook.addComment(0, 0, '总表批注');
    const detailId = workbook.addSheet('明细');
    workbook.addComment(1, 1, '明细批注');
    workbook.switchSheet('Sheet1');
    expect(workbook.getComment(comment.id).messages[0].text).toBe('总表批注');

    const restored = new Workbook({ enableWasm: false });
    restored.fromJSON(workbook.toJSON());
    expect(restored.getComments()).toHaveLength(1);
    restored.switchSheet(detailId);
    expect(restored.getComments()[0].messages[0].text).toBe('明细批注');
    workbook.destroy();
    restored.destroy();
  });
});

describe('CellCommentPlugin', () => {
  it('通过共享 API 使用配置的作者信息', () => {
    const workbook = new Workbook({ enableWasm: false });
    const plugin = new CellCommentPlugin({ userId: 'u1', userName: '协作者' });
    workbook.plugins.register(plugin);
    const add = workbook.plugins.getSharedState('comments:add');
    const comment = add(0, 0, '共享 API 批注');
    expect(comment.messages[0].authorName).toBe('协作者');
    expect(workbook.plugins.getSharedState('comments:getForCell')(0, 0)).toHaveLength(1);
    workbook.destroy();
  });

  it('优先使用实时协同用户身份作为批注作者', () => {
    const workbook = new Workbook({ enableWasm: false });
    workbook.plugins.register(new CollaborativeCursorPlugin());
    workbook.plugins.register(new RealtimeCollaborationPlugin({
      autoConnect: false,
      userId: 'u-sync',
      userName: '协同用户',
      userColor: '#e11d48'
    }));
    workbook.plugins.register(new CellCommentPlugin({ userId: 'u-local', userName: '我' }));

    const comment = workbook.plugins.getSharedState('comments:add')(0, 0, '身份测试');
    expect(comment.messages[0]).toMatchObject({
      authorId: 'u-sync',
      authorName: '协同用户',
      authorColor: '#e11d48'
    });

    workbook.destroy();
  });
});
