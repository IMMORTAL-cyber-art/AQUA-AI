import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { generateWithFailover, repairAndParseJSON } from "@/lib/gemini";
import { detectGeologicalFeatures } from "@/lib/vision";

const responseCache = new Map<string, any>();

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const customerName = formData.get("customerName") as string;
    const image = formData.get("image") as File;

    if (!customerName || !image) {
      return NextResponse.json({ error: "Missing name or image" }, { status: 400 });
    }

    const buffer = Buffer.from(await image.arrayBuffer());
    const originalImageType = image.type || "image/png";
    const originalImageUrl = `data:${originalImageType};base64,${buffer.toString("base64")}`;

    const canvasImage = await loadImage(buffer);
    const width = canvasImage.width;
    const height = canvasImage.height;

    const cvCanvas = createCanvas(width, height);
    const cvCtx = cvCanvas.getContext("2d");
    cvCtx.drawImage(canvasImage, 0, 0, width, height);
    const imageData = cvCtx.getImageData(0, 0, width, height);
    
    // Perform geological interpretation
    const { waterZones, pixelMap } = detectGeologicalFeatures(imageData, width, height);
    
    let bestBorewellX = width / 2;
    let recommendedZone = waterZones.length > 0 ? waterZones[0] : null;
    if (recommendedZone) {
      bestBorewellX = recommendedZone.centroidX;
    }

    const scale = width / 1200;
    const fontStack = "Inter, Roboto, Arial, Helvetica, 'Segoe UI', sans-serif";

    // --- GEMINI SUMMARIZATION ---
    let geminiJson;
    try {
      const cvSummary = waterZones.map(f => `${f.id}: Area=${f.area}, Score=${f.score}, DepthRangeY=${f.minY}-${f.maxY}`).join("\n");
      const prompt = `Act as an expert PQWT geological reporter. 
      I have ALREADY run a deterministic Borewell Interpreter pipeline. Here are the detected isolated water zones:
      ${cvSummary}
      
      Return ONLY a JSON object matching this structure:
      {
        "location": "string",
        "confidence": "string (High, Medium, Low)",
        "depthScale": [{ "yPixel": "number", "depthValue": "number" }],
        "originalProfileAnalysis": "string (Describe the visual profile generally)",
        "processedProfileAnalysis": "string (Summarize the detected Water Zones. Explain why the highest scoring anomaly is the best drill point.)"
      }`;
      
      const imageHash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (responseCache.has(imageHash)) {
        geminiJson = JSON.parse(JSON.stringify(responseCache.get(imageHash)));
      } else {
        const responseText = await generateWithFailover(prompt, {
          data: buffer.toString("base64"),
          mimeType: image.type
        });
        geminiJson = repairAndParseJSON(responseText);
        responseCache.set(imageHash, JSON.parse(JSON.stringify(geminiJson)));
      }
    } catch (e: any) {
      console.error("Gemini API Error:", e.message);
      return NextResponse.json({ error: e.message || "Failed to summarize image with AI." }, { status: 500 });
    }

    // Pixel to depth mapping based on OCR scale
    let validScale = false;
    let depthScale = geminiJson.depthScale;
    if (Array.isArray(depthScale) && depthScale.length >= 2) {
      depthScale = depthScale.map((d: any) => ({ yPixel: Number(d.yPixel), depthValue: Math.abs(Number(d.depthValue)) }))
                             .filter((d: any) => !isNaN(d.yPixel) && !isNaN(d.depthValue))
                             .sort((a: any, b: any) => a.yPixel - b.yPixel);
      if (depthScale.length >= 2) validScale = true;
    }

    const pixelToDepth = (y: number): string | number => {
      if (!validScale) return -1;
      if (y <= depthScale[0].yPixel) return depthScale[0].depthValue;
      if (y >= depthScale[depthScale.length - 1].yPixel) return depthScale[depthScale.length - 1].depthValue;
      for (let i = 0; i < depthScale.length - 1; i++) {
        const p1 = depthScale[i];
        const p2 = depthScale[i + 1];
        if (y >= p1.yPixel && y <= p2.yPixel) {
          const ratio = (y - p1.yPixel) / (p2.yPixel - p1.yPixel);
          return Math.round(p1.depthValue + ratio * (p2.depthValue - p1.depthValue));
        }
      }
      return -1;
    };

    // Annotate depth on features
    const mappedFeatures = waterZones.map((f, idx) => {
      const d1 = pixelToDepth(f.minY);
      const d2 = pixelToDepth(f.maxY);
      const dStr = (d1 !== -1 && d2 !== -1) ? `${d1}m - ${d2}m` : "Unavailable";
      return { ...f, depthRange: dStr };
    });

    // Helper to draw SMALL tight ellipse around gap
    const drawWaterZone = (ctx: any, f: any) => {
      const d1 = pixelToDepth(f.minY);
      const d2 = pixelToDepth(f.maxY);
      const dStr = (d1 !== -1 && d2 !== -1) ? `${d1}m - ${d2}m` : "";
      
      const ellipseColor = "rgba(255, 255, 0, 1)";
      if (f.polygon && f.polygon.length >= 6) {
        ctx.beginPath();
        ctx.moveTo(f.polygon[0], f.polygon[1]);
        for (let i = 2; i < f.polygon.length; i += 2) {
          ctx.lineTo(f.polygon[i], f.polygon[i+1]);
        }
        ctx.closePath();
        ctx.strokeStyle = ellipseColor;
        ctx.lineWidth = 4 * scale;
        ctx.setLineDash([10 * scale, 8 * scale]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const text = `${f.id}\n${dStr}`;
      const lines = text.split("\n");
      ctx.font = `bold ${16 * scale}px ${fontStack}`;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      const pad = 6 * scale;
      const tw = Math.max(ctx.measureText(lines[0]).width, ctx.measureText(lines[1] || "").width);
      const th = lines.length * 20 * scale;
      const x = f.maxX + 10 * scale;
      const y = f.minY + (f.maxY - f.minY) / 2;
      ctx.fillRect(x - pad, y - 16 * scale, tw + pad * 2, th + pad * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(lines[0], x, y + 2 * scale);
      if (lines[1]) ctx.fillText(lines[1], x, y + 22 * scale);
    };

    const drawDrillingLine = (ctx: any) => {
      if (!recommendedZone) return;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 255, 0, 0.9)";
      ctx.lineWidth = 4 * scale;
      ctx.moveTo(bestBorewellX, height * 0.15);
      ctx.lineTo(bestBorewellX, height * 0.95);
      ctx.stroke();

      const targetY = (recommendedZone.minY + recommendedZone.maxY) / 2;
      ctx.beginPath(); ctx.fillStyle = "rgba(255, 0, 0, 1)"; ctx.arc(bestBorewellX, targetY, 5 * scale, 0, 2 * Math.PI); ctx.fill();
      ctx.beginPath(); ctx.strokeStyle = "rgba(255, 0, 0, 1)"; ctx.lineWidth = 3 * scale; ctx.arc(bestBorewellX, targetY, 16 * scale, 0, 2 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.strokeStyle = "rgba(255, 0, 0, 1)"; ctx.lineWidth = 3 * scale;
      ctx.moveTo(bestBorewellX - 26 * scale, targetY); ctx.lineTo(bestBorewellX + 26 * scale, targetY);
      ctx.moveTo(bestBorewellX, targetY - 26 * scale); ctx.lineTo(bestBorewellX, targetY + 26 * scale);
      ctx.stroke();

      ctx.font = `bold ${18 * scale}px ${fontStack}`;
      const labelText = "BEST DRILLING POINT";
      const textW = ctx.measureText(labelText).width;
      const boxW = textW + 32 * scale;
      const boxH = 40 * scale;
      let boxX = bestBorewellX + 30 * scale;
      if (boxX + boxW > width - 10 * scale) boxX = bestBorewellX - boxW - 30 * scale;
      const boxY = targetY - boxH / 2;
      
      ctx.fillStyle = "rgba(220, 38, 38, 0.95)";
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, boxX + 16 * scale, boxY + 27 * scale);
    };

    // 1. AI Annotated Original Profile
    const aOrigCanvas = createCanvas(width, height);
    const aOrigCtx = aOrigCanvas.getContext('2d');
    aOrigCtx.drawImage(canvasImage, 0, 0, width, height);
    for (const f of waterZones) drawWaterZone(aOrigCtx, f);
    const annotatedOriginalImageUrl = `data:image/png;base64,${aOrigCanvas.toBuffer("image/png").toString("base64")}`;

    // 2. AI Processed Detection Map (Solid pixel colors based on context)
    const procCanvas = createCanvas(width, height);
    const procCtx = procCanvas.getContext('2d');
    const procImgData = procCtx.createImageData(width, height);
    
    // Interpret pixelMap into visual colors
    for(let i=0; i<pixelMap.length; i++){
      const type = pixelMap[i];
      const pIdx = i * 4;
      if (type === 1) { // Soft Rock
        procImgData.data[pIdx]=34; procImgData.data[pIdx+1]=197; procImgData.data[pIdx+2]=94; procImgData.data[pIdx+3]=255;
      } else if (type === 2) { // Hard Rock
        procImgData.data[pIdx]=234; procImgData.data[pIdx+1]=138; procImgData.data[pIdx+2]=36; procImgData.data[pIdx+3]=255;
      } else if (type === 3) { // Water Gap
        procImgData.data[pIdx]=30; procImgData.data[pIdx+1]=64; procImgData.data[pIdx+2]=175; procImgData.data[pIdx+3]=255;
      } else { // Background
        procImgData.data[pIdx]=240; procImgData.data[pIdx+1]=240; procImgData.data[pIdx+2]=240; procImgData.data[pIdx+3]=255;
      }
    }
    procCtx.putImageData(procImgData, 0, 0);
    const processedImageUrl = `data:image/png;base64,${procCanvas.toBuffer("image/png").toString("base64")}`;

    // 3. AI Annotated Processed Map
    const aProcCanvas = createCanvas(width, height);
    const aProcCtx = aProcCanvas.getContext('2d');
    aProcCtx.drawImage(procCanvas, 0, 0, width, height);
    for (const f of waterZones) drawWaterZone(aProcCtx, f);
    drawDrillingLine(aProcCtx);
    const annotatedProcessedImageUrl = `data:image/png;base64,${aProcCanvas.toBuffer("image/png").toString("base64")}`;

    let bestDepthStr = "No reliable drilling point detected.";
    if (recommendedZone) {
      const bestDepth = pixelToDepth((recommendedZone.minY + recommendedZone.maxY)/2);
      if (bestDepth !== -1) bestDepthStr = `${bestDepth}m`;
    }
    geminiJson.bestBorewellPoint = { depth: bestDepthStr };
    geminiJson.recommendedDrillingDepth = bestDepthStr;

    return NextResponse.json({ 
      success: true, 
      reportData: {
        customerName,
        originalImage: originalImageUrl,
        annotatedOriginalImage: annotatedOriginalImageUrl,
        processedImage: processedImageUrl,
        annotatedProcessedImage: annotatedProcessedImageUrl,
        features: mappedFeatures,
        geminiData: geminiJson
      }
    });

  } catch (error: any) {
    console.error("Upload API Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
