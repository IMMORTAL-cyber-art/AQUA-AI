import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createCanvas, loadImage, Canvas } from "@napi-rs/canvas";
import { generateWithFailover, repairAndParseJSON } from "@/lib/gemini";
import { detectGeologicalFeatures } from "@/lib/vision";

const responseCache = new Map<string, any>();

// =====================================================================
// Helper: Draw water zone annotations (ellipse + label) onto a context
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

    // Tight dashed yellow ellipse around only the water gap
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(f.polygon[0], f.polygon[1]);
    for (let i = 2; i < f.polygon.length; i += 2) {
      ctx.lineTo(f.polygon[i], f.polygon[i + 1]);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(255, 255, 0, 1)";
    ctx.lineWidth = 4 * scale;
    ctx.setLineDash([10 * scale, 8 * scale]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Label to the right of the zone
    const labelX = Math.min(f.maxX + 12 * scale, ctx.canvas ? ctx.canvas.width - 150 * scale : f.maxX + 12 * scale);
    const labelY = f.minY + (f.maxY - f.minY) / 2;
    const lines = dStr ? [f.id, dStr] : [f.id];

    ctx.save();
    ctx.font = `bold ${15 * scale}px ${fontStack}`;
    const maxLineW = Math.max(...lines.map((l: string) => ctx.measureText(l).width));
    const pad = 6 * scale;
    const lineH = 20 * scale;
    const boxH = lines.length * lineH + pad * 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fillRect(labelX - pad, labelY - lineH, maxLineW + pad * 2, boxH);
    ctx.fillStyle = "#ffffff";
    lines.forEach((line: string, idx: number) => {
      ctx.fillText(line, labelX, labelY + idx * lineH + 3 * scale);
    });
    ctx.restore();
  }
}

// =====================================================================
// Helper: Draw drilling line + crosshair + label
// =====================================================================
function drawDrillingLine(
  ctx: any,
  recommendedZone: any,
  bestBorewellX: number,
  width: number,
  height: number,
  scale: number,
  fontStack: string
) {
  if (!recommendedZone) return;

  // Green vertical line
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = "rgba(0, 255, 0, 0.9)";
  ctx.lineWidth = 4 * scale;
  ctx.moveTo(bestBorewellX, height * 0.1);
  ctx.lineTo(bestBorewellX, height * 0.97);
  ctx.stroke();

  // Red crosshair at the best drilling point
  const targetY = (recommendedZone.minY + recommendedZone.maxY) / 2;

  ctx.beginPath();
  ctx.fillStyle = "rgba(255, 0, 0, 1)";
  ctx.arc(bestBorewellX, targetY, 6 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = "rgba(255, 0, 0, 1)";
  ctx.lineWidth = 3 * scale;
  ctx.arc(bestBorewellX, targetY, 18 * scale, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = "rgba(255, 0, 0, 1)";
  ctx.lineWidth = 3 * scale;
  ctx.moveTo(bestBorewellX - 28 * scale, targetY);
  ctx.lineTo(bestBorewellX + 28 * scale, targetY);
  ctx.moveTo(bestBorewellX, targetY - 28 * scale);
  ctx.lineTo(bestBorewellX, targetY + 28 * scale);
  ctx.stroke();

  // "BEST DRILLING POINT" label box
  ctx.font = `bold ${18 * scale}px ${fontStack}`;
  const labelText = "BEST DRILLING POINT";
  const textW = ctx.measureText(labelText).width;
  const boxW = textW + 32 * scale;
  const boxH = 40 * scale;
  let boxX = bestBorewellX + 34 * scale;
  if (boxX + boxW > width - 10 * scale) boxX = bestBorewellX - boxW - 34 * scale;
  const boxY = targetY - boxH / 2;

  ctx.fillStyle = "rgba(220, 38, 38, 0.95)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(labelText, boxX + 16 * scale, boxY + 27 * scale);
  ctx.restore();
}

// =====================================================================
// IMAGE 2: Annotated Original Profile
// =====================================================================
async function createAnnotatedOriginal(
  canvasImage: any,
  width: number,
  height: number,
  waterZones: any[],
  recommendedZone: any,
  bestBorewellX: number,
  pixelToDepth: (y: number) => string | number,
  scale: number,
  fontStack: string
): Promise<string> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Draw the pristine original image as the base
  ctx.drawImage(canvasImage, 0, 0, width, height);

  // Draw water zones ON TOP of the original image
  drawWaterZones(ctx, waterZones, pixelToDepth, scale, fontStack);

  // Draw drilling line ON TOP of the original image
  drawDrillingLine(ctx, recommendedZone, bestBorewellX, width, height, scale, fontStack);

  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

// =====================================================================
// IMAGE 3: Processed Detection Map (no labels, no drilling line)
// =====================================================================
function createProcessedMap(
  pixelMap: Uint8Array,
  width: number,
  height: number
): { canvas: Canvas; dataUrl: string } {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(width, height);

  for (let i = 0; i < pixelMap.length; i++) {
    const type = pixelMap[i];
    const p = i * 4;
    if (type === 1) {          // Soft Rock → Green
      imgData.data[p] = 34;  imgData.data[p+1] = 197; imgData.data[p+2] = 94;  imgData.data[p+3] = 255;
    } else if (type === 2) {   // Hard Rock → Orange
      imgData.data[p] = 234; imgData.data[p+1] = 138; imgData.data[p+2] = 36;  imgData.data[p+3] = 255;
    } else if (type === 3) {   // Water Gap → Deep Blue
      imgData.data[p] = 30;  imgData.data[p+1] = 64;  imgData.data[p+2] = 175; imgData.data[p+3] = 255;
    } else {                   // Background → Light grey
      imgData.data[p] = 240; imgData.data[p+1] = 240; imgData.data[p+2] = 240; imgData.data[p+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  return {
    canvas,
    dataUrl: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`,
  };
}

// =====================================================================
// IMAGE 4: Annotated Processed Map
// =====================================================================
function createAnnotatedProcessed(
  processedCanvas: Canvas,
  width: number,
  height: number,
  waterZones: any[],
  recommendedZone: any,
  bestBorewellX: number,
  pixelToDepth: (y: number) => string | number,
  scale: number,
  fontStack: string
): string {
  // Fresh canvas — copy the processed map into it pixel-for-pixel
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Draw the processed map as the base
  ctx.drawImage(processedCanvas, 0, 0, width, height);

  // Draw zone annotations ON TOP of the processed map
  drawWaterZones(ctx, waterZones, pixelToDepth, scale, fontStack);

  // Draw drilling line ON TOP of the processed map
  drawDrillingLine(ctx, recommendedZone, bestBorewellX, width, height, scale, fontStack);

  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
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

    // IMAGE 1: raw original
    const originalImageUrl = `data:${originalImageType};base64,${buffer.toString("base64")}`;

    const canvasImage = await loadImage(buffer);
    const width = canvasImage.width;
    const height = canvasImage.height;

    // Run CV on a scratch canvas — do NOT touch the canvasImage object itself
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
        .map(f => `${f.id}: Area=${f.area}, Score=${f.score}, DepthRangeY=${f.minY}-${f.maxY}`)
        .join("\n");
      const prompt = `Act as an expert PQWT geological reporter.
I have ALREADY run a deterministic Borewell Interpreter pipeline. Here are the detected isolated water zones:
${cvSummary}

Return ONLY a JSON object matching this structure (no markdown, no explanation):
{
  "location": "string",
  "confidence": "string (High, Medium, Low)",
  "depthScale": [{ "yPixel": number, "depthValue": number }],
  "originalProfileAnalysis": "string",
  "processedProfileAnalysis": "string"
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

    // Depth calibration
    let validScale = false;
    let depthScale = geminiJson.depthScale;
    if (Array.isArray(depthScale) && depthScale.length >= 2) {
      depthScale = depthScale
        .map((d: any) => ({ yPixel: Number(d.yPixel), depthValue: Math.abs(Number(d.depthValue)) }))
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

    const mappedFeatures = waterZones.map(f => {
      const d1 = pixelToDepth(f.minY);
      const d2 = pixelToDepth(f.maxY);
      return {
        ...f,
        points: undefined, // strip heavy raw pixel arrays
        depthRange: (d1 !== -1 && d2 !== -1) ? `${d1}m - ${d2}m` : "Unavailable",
      };
    });

    // IMAGE 2: Annotated Original Profile
    const annotatedOriginalImageUrl = await createAnnotatedOriginal(
      canvasImage, width, height, waterZones, recommendedZone,
      bestBorewellX, pixelToDepth, scale, fontStack
    );

    // IMAGE 3: Processed Detection Map
    const { canvas: processedCanvas, dataUrl: processedImageUrl } = createProcessedMap(pixelMap, width, height);

    // IMAGE 4: Annotated Processed Map
    const annotatedProcessedImageUrl = createAnnotatedProcessed(
      processedCanvas, width, height, waterZones, recommendedZone,
      bestBorewellX, pixelToDepth, scale, fontStack
    );

    let bestDepthStr = "No reliable drilling point detected.";
    if (recommendedZone) {
      const bestDepth = pixelToDepth((recommendedZone.minY + recommendedZone.maxY) / 2);
      if (bestDepth !== -1) bestDepthStr = `${bestDepth}m`;
    }

    geminiJson.bestBorewellPoint = { depth: bestDepthStr };
    geminiJson.recommendedDrillingDepth = bestDepthStr;

    return NextResponse.json({
      success: true,
      reportData: {
        customerName,
        originalImage: originalImageUrl,          // 1: raw, no markings
        annotatedOriginalImage: annotatedOriginalImageUrl, // 2: original + annotations
        processedImage: processedImageUrl,         // 3: processed map, no annotations
        annotatedProcessedImage: annotatedProcessedImageUrl, // 4: processed + annotations
        features: mappedFeatures,
        geminiData: geminiJson,
      },
    });
  } catch (error: any) {
    console.error("Upload API Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
