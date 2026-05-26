import fs from 'fs';
import path from 'path';

const TARGET_DIRS = ['src/core', 'src/render', 'src/plugins'];

function fixImports(dir) {
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) return;

  const files = fs.readdirSync(absDir);

  files.forEach(file => {
    const filePath = path.join(absDir, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      fixImports(path.join(dir, file));
    } else if (file.endsWith('.js')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // 匹配相对路径的 import，且没有扩展名的
      // 捕获组 1: from ' 或 from "
      // 捕获组 2: 路径内容
      const newContent = content.replace(/(from\s+['"]|import\s+['"])(\.\.?\/[^'"]+?)(?<!\.js)(['"])/g, (match, p1, p2, p3) => {
        // 如果路径已经包含扩展名（简单检查是否有点且后面是常见扩展名），则跳过
        if (p2.match(/\.(js|mjs|wasm|vue|css)$/)) {
          return match;
        }
        console.log(`Fixing import in ${file}: ${p2} -> ${p2}.js`);
        return `${p1}${p2}.js${p3}`;
      });

      if (newContent !== content) {
        fs.writeFileSync(filePath, newContent);
      }
    }
  });
}

console.log('--- Starting ESM Import Fix ---');
TARGET_DIRS.forEach(fixImports);
console.log('--- Finished ---');
