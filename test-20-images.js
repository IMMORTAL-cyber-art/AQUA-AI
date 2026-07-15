const fs = require('fs');
const path = require('path');

async function runTests() {
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  const files = fs.readdirSync(uploadsDir).filter(f => f.startsWith('original_') && (f.endsWith('.png') || f.endsWith('.jpg')));
  
  // Pick 20 images
  const testFiles = files.slice(0, 20);
  console.log('Starting automated test for ' + testFiles.length + ' images...');
  
  let successCount = 0;
  
  for (let i = 0; i < testFiles.length; i++) {
    const filename = testFiles[i];
    console.log('\n--- Test ' + (i+1) + '/' + testFiles.length + ': ' + filename + ' ---');
    
    const imagePath = path.join(uploadsDir, filename);
    const buffer = fs.readFileSync(imagePath);
    
    const form = new FormData();
    form.append('customerName', 'Integration Test User ' + i);
    
    const mimeType = filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    const file = new File([buffer], filename, { type: mimeType });
    form.append('image', file);
    
    try {
      const res = await fetch('http://localhost:3000/api/upload-and-analyze', {
        method: 'POST',
        body: form
      });
      
      const text = await res.text();
      if (!res.ok) {
        console.error('? HTTP Error ' + res.status + ' for ' + filename);
        continue;
      }
      
      let json = JSON.parse(text);
      if (json.success && json.reportData && json.reportData.geminiData && json.reportData.geminiData.drillingPlan) {
        console.log('? Passed. Extracted ' + json.reportData.geminiData.drillingPlan.length + ' drilling priority zones.');
        successCount++;
      } else {
        console.error('? Validation failed for ' + filename + '. Output missing critical fields.');
      }
    } catch (error) {
      console.error('? Exception for ' + filename + ':', error.message);
    }
  }
  console.log('\n\n=== TEST COMPLETE ===');
  console.log('Passed: ' + successCount + ' / ' + testFiles.length);
}
runTests();
