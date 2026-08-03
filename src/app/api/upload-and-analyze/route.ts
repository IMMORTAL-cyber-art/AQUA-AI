import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createCanvas, loadImage, Canvas } from "@napi-rs/canvas";
import { detectGeologicalFeatures } from "@/lib/vision";

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

  // Drilling Line - drawn through the cavity vertical extent only
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = "rgba(0, 255, 0, 0.9)";
  ctx.lineWidth = 4 * scale;
  ctx.moveTo(bestBorewellX, recommendedZone.minY);
  ctx.lineTo(bestBorewellX, recommendedZone.maxY);
  ctx.stroke();

  // Target Point - placed at the centroidY (center) of the cavity
  const targetY = recommendedZone.centroidY;
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

    // IMAGE 3 & 4: Processed Maps (Omitted from UI as requested)
    const processedImageUrl = null;
    const annotatedProcessedImageUrl = null;

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
