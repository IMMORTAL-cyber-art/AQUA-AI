const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

async function testOCR() {
  console.log("Initializing Tesseract OCR...");
  const worker = await createWorker('eng');
  
  const imagePath = path.join(__dirname, 'public', 'uploads', 'original_1783796972638.jpg');
  
  console.log("Running OCR on full image...");
  const { data: { text, words, lines } } = await worker.recognize(imagePath);
  
  console.log("\n--- Full Text Detected ---");
  console.log(text);
  
  console.log("\n--- Numeric Words Detected (Depth / Lines Candidates) ---");
  const numericWords = words.filter(w => /^-?\d+$/.test(w.text));
  numericWords.forEach(w => {
    console.log(`Text: '${w.text}', Box: x0=${w.bbox.x0}, y0=${w.bbox.y0}, x1=${w.bbox.x1}, y1=${w.bbox.y1}`);
  });
  
  await worker.terminate();
}

testOCR();
