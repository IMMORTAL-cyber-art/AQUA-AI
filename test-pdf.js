const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

async function run() {
  console.log("Generating report via test-workflow.js...");
  const output = execSync('node test-workflow.js').toString();
  console.log(output);
  
  const match = output.match(/Report ID:\s*([a-zA-Z0-9_]+)/);
  if (!match) {
    console.error("Could not find Report ID in output!");
    process.exit(1);
  }
  const reportId = match[1];
  console.log(`Testing PDF export for Report ID: ${reportId}`);
  
  const downloadPath = path.resolve(__dirname, 'downloads');
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Set download behavior
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error(`PAGE ERROR: ${msg.text()}`);
    } else {
      console.log(`PAGE LOG: ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    console.error(`PAGE EXCEPTION: ${err.toString()}`);
  });

  await page.goto(`http://localhost:3000/report/${reportId}`, { waitUntil: 'networkidle2' });
  
  console.log("Page loaded. Taking screenshot before PDF export...");
  await page.screenshot({ path: path.join(downloadPath, 'report_page.png'), fullPage: true });

  console.log("Clicking Export PDF button...");
  
  // Find the Export PDF button by text
  const exportBtn = await page.$('button.bg-blue-600');

  if (exportBtn) {
    await exportBtn.evaluate(b => b.click());
    console.log("Clicked! Waiting for PDF download...");
    
    // Wait for file in downloadPath
    let pdfDownloaded = false;
    for (let i = 0; i < 30; i++) {
      const files = fs.readdirSync(downloadPath);
      const pdfFiles = files.filter(f => f.endsWith('.pdf'));
      if (pdfFiles.length > 0) {
        console.log(`PDF successfully downloaded: ${pdfFiles[0]}`);
        pdfDownloaded = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    
    if (!pdfDownloaded) {
      console.error("PDF did not download within 30 seconds. Check console logs for html2canvas errors.");
    }
  } else {
    console.error("Export PDF button not found on page.");
  }
  
  await browser.close();
}

run().catch(console.error);
