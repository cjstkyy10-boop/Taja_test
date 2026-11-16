const fs = require('fs');
const path = require('path');

try {
  const srcDir = path.join(__dirname, 'public');
  const destDir = path.join(__dirname, 'dist');

  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory not found: ${srcDir}`);
  }

  // dist 디렉토리 안전하게 재생성
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  // 크로스 플랫폼 폴더/파일 재귀 복사 (Linux, macOS, Windows 모두 완벽 지원)
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(srcDir, destDir, { recursive: true });
  } else {
    function copyRecursive(src, dest) {
      const stats = fs.statSync(src);
      if (stats.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const item of fs.readdirSync(src)) {
          copyRecursive(path.join(src, item), path.join(dest, item));
        }
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    copyRecursive(srcDir, destDir);
  }

  console.log('Build completed successfully: public/ copied to dist/');
} catch (err) {
  console.error('Build error:', err);
  process.exit(1);
}
