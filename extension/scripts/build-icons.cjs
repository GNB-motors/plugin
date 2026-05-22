/**
 * Renders logo.svg → public/icons/icon{16,48,128}.png at the proper sizes.
 * Run: node scripts/build-icons.cjs
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, 'logo.svg');
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

if (!fs.existsSync(SRC)) {
  console.error('Missing logo.svg at', SRC);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const svg = fs.readFileSync(SRC);

(async () => {
  for (const size of [16, 48, 128]) {
    const out = path.join(OUT_DIR, `icon${size}.png`);
    await sharp(svg, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(out);
    console.log(`✓ icon${size}.png`);
  }
})();
