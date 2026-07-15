const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

async function testWorkflow() {
  console.log("Using real PQWT test image...");
  
  const imagePath = path.join(__dirname, 'public', 'uploads', 'original_1783796972638.jpg');
  const buffer = fs.readFileSync(imagePath);
  
  console.log("Uploading to API...");
  
  // Create native FormData for Node 18+
  const form = new FormData();
  form.append('customerName', 'Integration Test User');
  
  // Convert buffer to File/Blob for native fetch
  const file = new File([buffer], 'test_image.png', { type: 'image/png' });
  form.append('image', file);
  
  try {
    const res = await fetch("http://localhost:3000/api/upload-and-analyze", {
      method: 'POST',
      body: form
    });
    
    const text = await res.text();
    console.log("Response Status:", res.status);
    let json;
    try {
      json = JSON.parse(text);
      console.log("Response Body:", JSON.stringify(json, null, 2));
    } catch(e) {
      console.log("Raw Text:", text);
      throw e;
    }
    
    if (res.ok && json.success) {
      console.log("✅ API test passed! Report generated for:", json.reportData?.customerName);
    } else {
      console.error("❌ API test failed!");
    }
  } catch (error) {
    console.error("❌ Network or Execution error:", error);
  }
}

testWorkflow();
