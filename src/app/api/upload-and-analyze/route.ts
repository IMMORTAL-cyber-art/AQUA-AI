import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createCanvas, loadImage, Canvas } from "@napi-rs/canvas";
import { generateWithFailover, repairAndParseJSON } from "@/lib/gemini";
import { detectGeologicalFeatures } from "@/lib/vision";

const responseCache = new Map<string, any>();

// =====================================================================
// Helper: Draw tight polygons and labels
// =====================================================================
function drawWaterZones(
  ctx: any,
  zones: any[],
  pixelToDepth: (y: number) => string | number,
  scale: number,
  fontStack: string
) {
  for (const f of zones) {
    if (!f.polygon || f.polygon.length < 6) continue;

    const d1 = pixelToDepth(f.minY);
    const d2 = pixelToDepth(f.maxY);
    const dStr = (d1 !== -1 && d2 !== -1) ? `${d1}m – ${d2}m` : "";

    // Tight polygon boundary
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(f.polygon[0], f.polygon[1]);
    for (let i = 2; i < f.polygon.length; i += 2) {
      ctx.lineTo(f.polygon[i], f.polygon[i + 1]);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(255, 255, 0, 1)"; // Yellow boundary
    ctx.lineWidth = 3 * scale;
    ctx.setLineDash([8 * scale, 6 * scale]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Label
    const labelX = f.maxX + 10 * scale;
    const labelY = f.minY + (f.maxY - f.minY) / 2;
    const lines = dStr ? [f.id, dStr] : [f.id];

    ctx.save();
    ctx.font = `bold ${14 * scale}px ${fontStack}`;
    const maxLineW = Math.max(...lines.map((l: string) => ctx.measureText(l).width));
    const pad = 6 * scale;
    const lineH = 18 * scale;
    const boxH = lines.length * lineH + pad * 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(labelX - pad, labelY - lineH, maxLineW + pad * 2, boxH);
    ctx.fillStyle = "#ffffff";
    lines.forEach((line: string, idx: number) => {
      ctx.fillText(line, labelX, labelY + idx * lineH + 3 * scale);
    });
    ctx.restore();
  }
}

// =====================================================================
// Helper: Draw drilling line
// =====================================================================
function drawDrillingLine(
  ctx: any,
  recommendedZone: any,
  bestBorewellX: number,
  width: number,
  height: number,
  scale: number,
  fontStack: string,
  pixelToDepth: (y: number) => string | number
) {
  if (!recommendedZone) return;

  // Drilling Line
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = "rgba(0, 255, 0, 0.9)";
  ctx.lineWidth = 4 * scale;
  ctx.moveTo(bestBorewellX, height * 0.1);
  ctx.lineTo(bestBorewellX, height * 0.97);
  ctx.stroke();

  // Target Point
  const targetY = recommendedZone.minY;
  ctx.beginPath();
  ctx.fillStyle = "rgba(255, 0, 0, 1)";
  ctx.arc(bestBorewellX, targetY, 6 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = "rgba(255, 0, 0, 1)";
  ctx.lineWidth = 3 * scale;
  ctx.moveTo(bestBorewellX - 25 * scale, targetY);
  ctx.lineTo(bestBorewellX + 25 * scale, targetY);
  ctx.moveTo(bestBorewellX, targetY - 25 * scale);
  ctx.lineTo(bestBorewellX, targetY + 25 * scale);
  ctx.stroke();

  // Label
  const d1 = pixelToDepth(recommendedZone.minY);
  const d2 = pixelToDepth(recommendedZone.maxY);
  const depthStr = (d1 !== -1 && d2 !== -1) ? `${d1}m–${d2}m` : "Unknown";
  
  ctx.font = `bold ${16 * scale}px ${fontStack}`;
  const lines = ["Best Drilling Point", `Recommended: ${depthStr}`];
  const maxW = Math.max(...lines.map((l: string) => ctx.measureText(l).width));
  const boxW = maxW + 24 * scale;
  const boxH = 50 * scale;
  let boxX = bestBorewellX + 25 * scale;
  if (boxX + boxW > width - 10 * scale) boxX = bestBorewellX - boxW - 25 * scale;
  const boxY = targetY - boxH / 2;

  ctx.fillStyle = "rgba(220, 38, 38, 0.95)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(lines[0], boxX + 12 * scale, boxY + 20 * scale);
  ctx.fillText(lines[1], boxX + 12 * scale, boxY + 40 * scale);
  ctx.restore();
}

// =====================================================================
// POST handler
// =====================================================================
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

    const { waterZones, pixelMap } = detectGeologicalFeatures(imageData, width, height);

    const recommendedZone = waterZones.length > 0 ? waterZones[0] : null;
    const bestBorewellX = recommendedZone ? recommendedZone.centroidX : width / 2;

    const scale = width / 1200;
    const fontStack = "Inter, Roboto, Arial, Helvetica, 'Segoe UI', sans-serif";

    // --- GEMINI SUMMARIZATION ---
    let geminiJson: any;
    try {
      const cvSummary = waterZones
        .map(f => `${f.id}: TopDepthY=${f.minY}, BottomDepthY=${f.maxY}, Width=${f.horizontalWidth}, VerticalContinuity=${f.verticalThickness}, RockAbove=${f.rockAbove}, RockSurrounding=${f.rockSurrounding}`)
        .join("\n");
        
      const prompt = `Act as an expert PQWT geological reporter.
I have ALREADY run a deterministic Borewell Interpreter pipeline based on morphological closing and cavity extraction. 
Here are the detected isolated water zones:
${cvSummary}

Return ONLY a JSON object matching this exact structure (no markdown, no explanation):
{
  "location": "string",
  "confidence": "string (High, Medium, Low)",
  "depthScale": [{ "yPixel": number, "depthValue": number }],
  "originalProfileAnalysis": "string (Describe what was found generally)",
  "processedProfileAnalysis": "string (Explain the drill decision. Why was the best gap chosen based on geometry, soft/hard rock context, and thickness?)"
}`;

      const imageHash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (responseCache.has(imageHash)) {
        geminiJson = JSON.parse(JSON.stringify(responseCache.get(imageHash)));
      } else {
        const responseText = await generateWithFailover(prompt, {
          data: buffer.toString("base64"),
          mimeType: image.type,
        });
        geminiJson = repairAndParseJSON(responseText);
        responseCache.set(imageHash, JSON.parse(JSON.stringify(geminiJson)));
      }
    } catch (e: any) {
      console.error("Gemini API Error:", e.message);
      return NextResponse.json({ error: e.message || "Gemini analysis failed." }, { status: 500 });
    }

    let validScale = false;
    let depthScale = geminiJson.depthScale;
    if (Array.isArray(depthScale) && depthScale.length >= 2) {
      depthScale = depthScale
        .map((d: any) => ({ yPixel: Number(d.yPixel), depthValue: Math.abs(Number(d.depthValue)) }))
        .filter((d: any) => !isNaN(d.yPixel) && !isNaN(d.depthValue))
        .sort((a: any, b: any) => a.yPixel - b.yPixel);
      if (depthScale.length >= 2) validScale = true;
    }

    if (!validScale) {
      const marginYTop = Math.round(height * 0.15);
      const marginYBot = Math.round(height * 0.08);
      const startY = marginYTop;
      const endY = height - marginYBot;
      
      console.log(`[Scale Calibration Fallback] Depth scale missing/invalid. Calibrating Y: ${startY} -> ${endY} to 0m -> 150m.`);
      depthScale = [
        { yPixel: startY, depthValue: 0 },
        { yPixel: endY, depthValue: 150 }
      ];
      validScale = true;
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

    const mappedFeatures = waterZones.map(f => {
      const d1 = pixelToDepth(f.minY);
      const d2 = pixelToDepth(f.maxY);
      return {
        ...f,
        points: undefined,
        depthRange: (d1 !== -1 && d2 !== -1) ? `${d1}m - ${d2}m` : "Unavailable",
      };
    });

    // IMAGE 2: Annotated Original Profile
    const aOrigCanvas = createCanvas(width, height);
    const aOrigCtx = aOrigCanvas.getContext("2d");
    aOrigCtx.drawImage(canvasImage, 0, 0, width, height);
    drawWaterZones(aOrigCtx, waterZones, pixelToDepth, scale, fontStack);
    drawDrillingLine(aOrigCtx, recommendedZone, bestBorewellX, width, height, scale, fontStack, pixelToDepth);
    const annotatedOriginalImageUrl = `data:image/png;base64,${aOrigCanvas.toBuffer("image/png").toString("base64")}`;

    // IMAGE 3: Processed Detection Map
    const procCanvas = createCanvas(width, height);
    const procCtx = procCanvas.getContext("2d");
    const procImgData = procCtx.createImageData(width, height);
    for (let i = 0; i < pixelMap.length; i++) {
      const type = pixelMap[i];
      const p = i * 4;
      if (type === 1) {          // Soft Rock → Green
        procImgData.data[p] = 34;  procImgData.data[p+1] = 197; procImgData.data[p+2] = 94;  procImgData.data[p+3] = 255;
      } else if (type === 2) {   // Hard Rock → Orange
        procImgData.data[p] = 234; procImgData.data[p+1] = 138; procImgData.data[p+2] = 36;  procImgData.data[p+3] = 255;
      } else if (type === 3) {   // Water Gap → Deep Blue
        procImgData.data[p] = 30;  procImgData.data[p+1] = 64;  procImgData.data[p+2] = 175; procImgData.data[p+3] = 255;
      } else {                   // Background → Light grey
        procImgData.data[p] = 240; procImgData.data[p+1] = 240; procImgData.data[p+2] = 240; procImgData.data[p+3] = 255;
      }
    }
    procCtx.putImageData(procImgData, 0, 0);
    const processedImageUrl = `data:image/png;base64,${procCanvas.toBuffer("image/png").toString("base64")}`;

    // IMAGE 4: Annotated Processed Map
    const aProcCanvas = createCanvas(width, height);
    const aProcCtx = aProcCanvas.getContext("2d");
    aProcCtx.drawImage(procCanvas, 0, 0, width, height);
    drawWaterZones(aProcCtx, waterZones, pixelToDepth, scale, fontStack);
    drawDrillingLine(aProcCtx, recommendedZone, bestBorewellX, width, height, scale, fontStack, pixelToDepth);
    const annotatedProcessedImageUrl = `data:image/png;base64,${aProcCanvas.toBuffer("image/png").toString("base64")}`;

    let bestDepthStr = "No reliable drilling point detected.";
    let startDepth = "N/A";
    let endDepth = "N/A";
    
    if (recommendedZone) {
      const d1 = pixelToDepth(recommendedZone.minY);
      const d2 = pixelToDepth(recommendedZone.maxY);
      if (d1 !== -1 && d2 !== -1) {
        bestDepthStr = `${d1}m–${d2}m`;
        startDepth = `${d1}m`;
        endDepth = `${d2}m`;
      }
    }

    // Pre-Report Validation: check total detected cavities, selected cavity, reason for selection, and recommended drilling range
    const totalDetectedCavities = waterZones.length;
    const selectedCavity = recommendedZone;
    let selectionReason = "";
    if (selectedCavity) {
      selectionReason = `Selected Water Zone "${selectedCavity.id}" with score ${selectedCavity.score.toFixed(1)} based on: size (${selectedCavity.area} px), vertical continuity (${selectedCavity.verticalThickness} px), surrounding rock, rock above, and depth.`;
    } else {
      selectionReason = "No cavities detected.";
    }

    console.log(`[Pre-Report Validation] Running validation checks...`);
    console.log(`- Total detected cavities: ${totalDetectedCavities}`);
    console.log(`- Selected cavity: ${selectedCavity ? selectedCavity.id : "None"}`);
    console.log(`- Reason for selection: ${selectionReason}`);
    console.log(`- Recommended drilling range: ${bestDepthStr}`);

    if (totalDetectedCavities > 0) {
      if (!selectedCavity) {
        throw new Error("Validation failed: cavities exist but no cavity was selected.");
      }
      if (bestDepthStr === "No reliable drilling point detected." || bestDepthStr.includes("Unavailable") || bestDepthStr.includes("Unknown")) {
        throw new Error("Validation failed: cavity exists but recommended drilling range is empty/placeholder.");
      }
    } else {
      if (selectedCavity) {
        throw new Error("Validation failed: no cavities detected but a cavity was selected.");
      }
      if (bestDepthStr !== "No reliable drilling point detected.") {
        throw new Error(`Validation failed: no cavities detected but recommended range is not "No reliable drilling point detected.": ${bestDepthStr}`);
      }
    }
    console.log(`[Pre-Report Validation] ✅ All checks passed.`);

    // Debug logging for final drilling depth calculation
    if (recommendedZone) {
      const minY = recommendedZone.minY;
      const maxY = recommendedZone.maxY;
      const d1 = pixelToDepth(minY);
      const d2 = pixelToDepth(maxY);
      
      console.log(`[Debug Log] Final drilling depth calculation:`);
      console.log(`- Selected cavity range: Y pixel ${minY} to ${maxY}`);
      console.log(`- Depth scale reference points: ${JSON.stringify(depthScale)}`);
      console.log(`- Start depth: pixelToDepth(${minY}) = ${d1}m`);
      console.log(`- End depth: pixelToDepth(${maxY}) = ${d2}m`);
      console.log(`- Recommended drilling range result: ${d1}m–${d2}m`);
    } else {
      console.log(`[Debug Log] Final drilling depth calculation: No cavities detected. Result: No reliable drilling point detected.`);
    }

    geminiJson.bestBorewellPoint = { 
      depth: bestDepthStr,
      id: recommendedZone ? recommendedZone.id : "None",
      startDepth,
      endDepth
    };
    geminiJson.recommendedDrillingDepth = bestDepthStr;
    geminiJson.startDepth = startDepth;
    geminiJson.endDepth = endDepth;

    return NextResponse.json({
      success: true,
      reportData: {
        customerName,
        originalImage: originalImageUrl,
        annotatedOriginalImage: annotatedOriginalImageUrl,
        processedImage: processedImageUrl,
        annotatedProcessedImage: annotatedProcessedImageUrl,
        features: mappedFeatures,
        geminiData: geminiJson,
      },
    });
  } catch (error: any) {
    console.error("Upload API Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
