const fs = require('fs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

async function main() {
  const image = await loadImage('public/uploads/original_1783796972638.jpg');
  const width = image.width;
  
  // Crop the bottom margin where survey lines might be
  const yStart = 1150; // just above cropEndY
  const yEnd = image.height; // bottom of image
  const cropHeight = yEnd - yStart;
  
  const topStripCanvas = createCanvas(width, cropHeight);
  const topCtx = topStripCanvas.getContext('2d');
  topCtx.fillStyle = '#ffffff';
  topCtx.fillRect(0, 0, width, cropHeight);
  topCtx.drawImage(image, 0, yStart, width, cropHeight, 0, 0, width, cropHeight);
  
  fs.writeFileSync('strip.png', topStripCanvas.toBuffer('image/png'));
  console.log(`Saved strip.png (Y=${yStart} to ${yEnd})`);
}

main();
