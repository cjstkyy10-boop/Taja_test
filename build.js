const fs = require('fs');
const path = require('path');

try {
  const srcDir = path.join(__dirname, 'public');
  const destDir = path.join(__dirname, 'dist');

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    const srcFile = path.join(srcDir, file);
    const destFile = path.join(destDir, file);
    fs.copyFileSync(srcFile, destFile);
    console.log(`Copied: ${file}`);
  }

  console.log('Build completed successfully.');
} catch (err) {
  console.error('Build error:', err);
  process.exit(1);
}
