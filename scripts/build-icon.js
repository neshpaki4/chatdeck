const fs = require('fs');
const path = require('path');
const { makeIcon, pngToIco } = require('../icon');

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), makeIcon(256));
fs.writeFileSync(path.join(dir, 'icon.ico'), pngToIco(makeIcon(256)));
console.log('OK: assets/icon.png + assets/icon.ico');