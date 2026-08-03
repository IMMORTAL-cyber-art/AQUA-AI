const { createWorker } = require('tesseract.js');

async function testOCR() {
  const worker = await createWorker('eng');
  const { data: { words } } = await worker.recognize('public/uploads/original_1783796972638.jpg');
  
  const numericWords = words ? words.filter(w => /^[0-9]+$/.test(w.text)) : [];
  numericWords.forEach(w => {
    console.log(`Num: '${w.text}', Y: ${w.bbox.y0} to ${w.bbox.y1}`);
  });
  
  await worker.terminate();
}

testOCR();
