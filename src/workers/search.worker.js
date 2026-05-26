self.onmessage = function(e) {
  const { taskId, chunk, query, options = {} } = e.data;
  if (!chunk || !query) {
    self.postMessage({ taskId, success: true, result: [] });
    return;
  }

  const results = [];
  const { caseSensitive = false, wholeWord = false } = options;
  
  // 解析查询（支持正则）
  const regexMatch = query.match(/^\/(.+)\/([gimsuy]*)$/);
  let regex = null;
  let queryStr = String(query);

  if (regexMatch) {
    try {
      const pattern = regexMatch[1];
      const flags = regexMatch[2] || '';
      const finalFlags = caseSensitive ? flags.replace('i', '') : (flags.includes('i') ? flags : flags + 'i');
      regex = new RegExp(pattern, finalFlags);
    } catch (err) {
      // 无效正则，降级到普通文本
    }
  }

  if (!regex) {
    if (wholeWord) {
      const escaped = queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(`^${escaped}$`, caseSensitive ? '' : 'i');
    } else if (!caseSensitive) {
      queryStr = queryStr.toLowerCase();
    }
  }

  for (let i = 0; i < chunk.length; i++) {
    const cellRef = chunk[i];
    const val = cellRef.v;
    if (val === undefined || val === null) continue;
    
    const valStr = String(val);
    let matched = false;

    if (regex) {
      matched = regex.test(valStr);
    } else {
      if (caseSensitive) {
        matched = valStr.includes(queryStr);
      } else {
        matched = valStr.toLowerCase().includes(queryStr);
      }
    }

    if (matched) {
      results.push({ r: cellRef.r, c: cellRef.c });
    }
  }
  
  self.postMessage({ taskId, success: true, result: results });
};
