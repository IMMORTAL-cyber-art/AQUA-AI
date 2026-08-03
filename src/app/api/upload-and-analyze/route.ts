import { NextRequest, NextResponse } from "next/server";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { detectGeologicalFeatures } from "@/lib/vision";
import { createWorker } from "tesseract.js";

// Force Node.js runtime because Tesseract.js uses native modules and filesystem access

// =====================================================================
// Helper: Draw tight polygons and labels
// =====================================================================
// =====================================================================
// Helper: Draw water zones
// =====================================================================
function drawWaterZones(
  ctx: any,
  zones: any[],
  scale: number
) {
  for (const f of zones) {
    if (!f.polygon || f.polygon.length < 6) continue;
    const radiusX = (f.maxX - f.minX) / 2;
    const radiusY = (f.maxY - f.minY) / 2;
    const centerX = f.minX + radiusX;
    const centerY = f.minY + radiusY;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255, 255, 0, 1)"; // Yellow oval
    ctx.lineWidth = 3 * scale;
    ctx.stroke();
    ctx.restore();
  }
}

// =====================================================================
// Helper: Draw interpretation panel (Right side)
// =====================================================================
function drawInterpretationPanel(
  ctx: any,
  width: number,
  scale: number,
  fontStack: string,
  totalAnomalies: number,
  bestDepthStr: string,
  recommendedZone: any
) {
  const panelW = 320 * scale;
  const panelH = 170 * scale;
  const panelX = width - panelW - 30 * scale;
  const panelY = 50 * scale;

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1 * scale;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${18 * scale}px ${fontStack}`;
  ctx.fillText("GEOLOGICAL REPORT", panelX + 20 * scale, panelY + 40 * scale);

  ctx.font = `${14 * scale}px ${fontStack}`;
  ctx.fillText(`Anomalies Detected: ${totalAnomalies}`, panelX + 20 * scale, panelY + 70 * scale);
  
  if (recommendedZone) {
    ctx.fillText(`Primary Target: ${recommendedZone.id}`, panelX + 20 * scale, panelY + 100 * scale);
    ctx.fillText(`Drilling Depth: ${bestDepthStr}`, panelX + 20 * scale, panelY + 125 * scale);
    ctx.fillText(`Surrounding: ${recommendedZone.rockSurrounding}`, panelX + 20 * scale, panelY + 150 * scale);
  } else {
    ctx.fillText("No primary target identified.", panelX + 20 * scale, panelY + 100 * scale);
  }
  
  ctx.restore();
}

// =====================================================================
// Helper: Draw legend (Bottom left)
// =====================================================================
function drawLegend(ctx: any, height: number, scale: number, fontStack: string) {
  const panelW = 280 * scale;
  const panelH = 90 * scale;
  const panelX = 30 * scale;
  const panelY = height - panelH - 30 * scale;

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  ctx.fillRect(panelX, panelY, panelW, panelH);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1 * scale;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${14 * scale}px ${fontStack}`;
  ctx.fillText("LEGEND", panelX + 15 * scale, panelY + 25 * scale);

  ctx.font = `${13 * scale}px ${fontStack}`;
  
  // Yellow oval icon
  ctx.beginPath();
  ctx.ellipse(panelX + 25 * scale, panelY + 42 * scale, 8 * scale, 4 * scale, 0, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255, 255, 0, 1)";
  ctx.lineWidth = 2 * scale;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Detected Anomaly", panelX + 45 * scale, panelY + 47 * scale);

  // Green line icon
  ctx.beginPath();
  ctx.moveTo(panelX + 25 * scale, panelY + 62 * scale);
  ctx.lineTo(panelX + 25 * scale, panelY + 76 * scale);
  ctx.strokeStyle = "rgba(0, 255, 0, 1)";
  ctx.lineWidth = 3 * scale;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Best Drilling Line", panelX + 45 * scale, panelY + 73 * scale);

  ctx.restore();
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
  pixelToDepth: (y: number) => string | number,
  pixelToSurveyLine: (x: number) => string
) {
  if (!recommendedZone) return;

  // Find surface Y (ground level = 0m)
  let surfaceY = 0;
  for (let y = 0; y < height; y++) {
    if (pixelToDepth(y) === 0) {
      surfaceY = y;
      break;
    }
  }

  // 1. Draw one solid green vertical line from ground surface to recommended depth
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = "rgba(0, 255, 0, 1)";
  ctx.lineWidth = 6 * scale; // Thicker than survey grid lines
  ctx.moveTo(bestBorewellX, surfaceY);
  ctx.lineTo(bestBorewellX, recommendedZone.maxY);
  ctx.stroke();

  // 2. Add Label
  const d1 = pixelToDepth(recommendedZone.minY);
  const d2 = pixelToDepth(recommendedZone.maxY);
  const depthStr = (d1 !== -1 && d2 !== -1) ? `${d1}m–${d2}m` : "Unknown";
  const sLine = pixelToSurveyLine(recommendedZone.centroidX);
  
  ctx.font = `bold ${18 * scale}px ${fontStack}`;
  const lines = ["BEST DRILLING LINE", sLine, `Depth ${depthStr}`];
  const maxW = Math.max(...lines.map((l: string) => ctx.measureText(l).width));
  const boxW = maxW + 24 * scale;
  const boxH = 75 * scale;
  
  // Position label directly above the map, aligned horizontally with the green line
  let boxX = bestBorewellX - (boxW / 2);
  if (boxX < 0) boxX = 0;
  if (boxX + boxW > width) boxX = width - boxW;
  
  let boxY = surfaceY - boxH - 10 * scale;
  if (boxY < 0) boxY = 10 * scale; // Fallback if there is no room at the top

  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#00ff00";
  ctx.fillText(lines[0], boxX + (boxW - ctx.measureText(lines[0]).width) / 2, boxY + 24 * scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(lines[1], boxX + (boxW - ctx.measureText(lines[1]).width) / 2, boxY + 46 * scale);
  ctx.fillText(lines[2], boxX + (boxW - ctx.measureText(lines[2]).width) / 2, boxY + 68 * scale);
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
    const maxDepth = Number(formData.get("maxDepth")) || 150;

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

    const { waterZones, pixelMap, cropStartY, cropEndY, composition } = detectGeologicalFeatures(imageData, width, height, maxDepth);

    const recommendedZone = waterZones.length > 0 ? waterZones[0] : null;
    const bestBorewellX = recommendedZone ? recommendedZone.centroidX : width / 2;

    const scale = width / 1200;
    const fontStack = "Inter, Roboto, Arial, Helvetica, 'Segoe UI', sans-serif";

    // --- DETERMINISTIC DEPTH SCALE CALIBRATION ---
    console.log(`[Scale Calibration] Setting Y: ${cropStartY} -> ${cropEndY} to 0m -> ${maxDepth}m.`);
    const depthScale = [
      { yPixel: cropStartY, depthValue: 0 },
      { yPixel: cropEndY, depthValue: maxDepth }
    ];
    const validScale = true;

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

    // --- OCR SURVEY LINE CALIBRATION ---
    console.log("[OCR] Initializing Tesseract for X-axis survey line detection...");
    const worker = await createWorker('eng');
    
    // Crop the top margin for Survey Lines
    // We will now pass the full image buffer to ensure we find the numbers anywhere
    console.log("[OCR] Running recognize on full image...");
    const { data: { words } } = await worker.recognize(buffer);
    await worker.terminate();

    // Group numeric words by their horizontal row (Y-axis proximity)
    const numericWords = words ? words.filter(w => /^\d+$/.test(w.text)) : [];
    const rows: { [y: string]: any[] } = {};
    numericWords.forEach(w => {
      const centerY = (w.bbox.y0 + w.bbox.y1) / 2;
      // Round to nearest 20 pixels to group them in the same row
      const bucket = Math.round(centerY / 20) * 20;
      if (!rows[bucket]) rows[bucket] = [];
      rows[bucket].push(w);
    });

    let bestRow: any[] = [];
    for (const key in rows) {
      if (rows[key].length > bestRow.length) {
        bestRow = rows[key];
      }
    }

    const surveyLines = bestRow.map(w => ({
      xPixel: (w.bbox.x0 + w.bbox.x1) / 2,
      lineValue: parseInt(w.text, 10)
    })).sort((a, b) => a.xPixel - b.xPixel);

    console.log(`[OCR] Detected ${surveyLines.length} survey lines:`, surveyLines.map(s => `Line ${s.lineValue} at X=${s.xPixel.toFixed(0)}`).join(', '));

    const pixelToSurveyLine = (x: number): string => {
      if (surveyLines.length === 0) return "Unavailable";
      if (surveyLines.length === 1) return `Line ${surveyLines[0].lineValue}`;
      
      if (x <= surveyLines[0].xPixel) return `Line ${surveyLines[0].lineValue}`;
      if (x >= surveyLines[surveyLines.length - 1].xPixel) return `Line ${surveyLines[surveyLines.length - 1].lineValue}`;
      
      for (let i = 0; i < surveyLines.length - 1; i++) {
        const p1 = surveyLines[i];
        const p2 = surveyLines[i + 1];
        if (x >= p1.xPixel && x <= p2.xPixel) {
          const ratio = (x - p1.xPixel) / (p2.xPixel - p1.xPixel);
          const interpolated = p1.lineValue + ratio * (p2.lineValue - p1.lineValue);
          return `Line ${interpolated.toFixed(1)}`;
        }
      }
      return "Unavailable";
    };

    // --- DETERMINISTIC ANALYSIS TEXT ---
    let originalProfileAnalysis = "No geological features were identified in the scanned area.";
    let processedProfileAnalysis = "Unable to determine a suitable drilling point.";
    if (recommendedZone) {
      originalProfileAnalysis = `Detected ${waterZones.length} candidate aquifer zones. The features were extracted using deterministic pixel morphology with a ${maxDepth}m depth scale.`;
      processedProfileAnalysis = `Selected ${recommendedZone.id} as the Best Drilling Point because it has the highest geological score (${recommendedZone.score.toFixed(1)}). It has a contiguous area of ${recommendedZone.area} pixels, spans a vertical thickness from ${pixelToDepth(recommendedZone.minY)}m to ${pixelToDepth(recommendedZone.maxY)}m, and is bounded by ${recommendedZone.rockSurrounding}.`;
    }

    const geminiJson = {
      location: "Local Assessment",
      confidence: recommendedZone ? (recommendedZone.confidence >= 70 ? "High" : (recommendedZone.confidence >= 40 ? "Medium" : "Low")) : "None",
      depthScale,
      originalProfileAnalysis,
      processedProfileAnalysis,
      composition
    } as any;

    const mappedFeatures: any[] = [];

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

    // IMAGE 2: Annotated Original Profile
    const aOrigCanvas = createCanvas(width, height);
    const aOrigCtx = aOrigCanvas.getContext("2d");
    aOrigCtx.drawImage(canvasImage, 0, 0, width, height);
    drawWaterZones(aOrigCtx, waterZones, scale);
    drawDrillingLine(aOrigCtx, recommendedZone, bestBorewellX, width, height, scale, fontStack, pixelToDepth, pixelToSurveyLine);
    drawInterpretationPanel(aOrigCtx, width, scale, fontStack, waterZones.length, bestDepthStr, recommendedZone);
    drawLegend(aOrigCtx, height, scale, fontStack);
    const annotatedOriginalImageUrl = `data:image/png;base64,${aOrigCanvas.toBuffer("image/png").toString("base64")}`;

    // IMAGE 3 & 4: Processed Maps (Omitted from UI as requested)
    const processedImageUrl = null;
    const annotatedProcessedImageUrl = null;

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
