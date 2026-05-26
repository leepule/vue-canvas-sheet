import fs from 'fs';
import path from 'path';

/**
 * 2026 全量 License 注入工具
 */

const CURRENT_YEAR = '2026';
const PROJECT_NAME = 'Vue-Canvas-Sheet';

const HEADERS = {
  js: `/**
 * ${PROJECT_NAME}
 * (c) ${CURRENT_YEAR}-present
 * Released under the MIT License.
 */
`,
  rs: `// ${PROJECT_NAME}
// (c) ${CURRENT_YEAR}-present
// Released under the MIT License.

`,
  vue: `<!--
  ${PROJECT_NAME}
  (c) ${CURRENT_YEAR}-present
  Released under the MIT License.
-->
`
};

const TARGET_DIRS = [
  'src/core', 
  'src/render', 
  'src/plugins', 
  'src/wasm/src'
];

const EXT_MAPPING = {
  '.js': 'js',
  '.mjs': 'js',
  '.rs': 'rs',
  '.vue': 'vue'
};

function processFile(filePath) {
  const ext = path.extname(filePath);
  const type = EXT_MAPPING[ext];
  if (!type) return;

  let content = fs.readFileSync(filePath, 'utf8');
  const header = HEADERS[type];
  
  // 检查是否已经有版权声明
  const hasOldHeader = content.includes('(c) 2024-present') || content.includes('(c) 2025-present');
  const hasCurrentHeader = content.includes(`(c) ${CURRENT_YEAR}-present`);

  if (hasOldHeader) {
    console.log(`[UPDATE]  ${path.relative(process.cwd(), filePath)} (Year -> ${CURRENT_YEAR})`);
    content = content.replace(/\(c\) 202[45]-present/g, `(c) ${CURRENT_YEAR}-present`);
    fs.writeFileSync(filePath, content);
  } else if (!hasCurrentHeader) {
    console.log(`[INJECT]  ${path.relative(process.cwd(), filePath)}`);
    // 注入到最开头
    fs.writeFileSync(filePath, header + content);
  }
}

function walk(dir) {
  const absoluteDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absoluteDir)) return;

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else {
      processFile(fullPath);
    }
  }
}

console.log(`\x1b[36m--- ${PROJECT_NAME} License Tool (${CURRENT_YEAR}) ---\x1b[0m`);
TARGET_DIRS.forEach(dir => {
  console.log(`\x1b[2mScanning: ${dir}...\x1b[0m`);
  walk(dir);
});
console.log('\x1b[32m--- Process Finished ---\x1b[0m');
