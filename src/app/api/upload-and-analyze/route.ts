import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { generateWithFailover, repairAndParseJSON } from "@/lib/gemini";
import { detectGeologicalFeatures, generateDetectionMask } from "@/lib/vision";

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

    // --- CV DETECTION ---
    const cvCanvas = createCanvas(width, height);
    const cvCtx = cvCanvas.getContext("2d");
    cvCtx.drawImage(canvasImage, 0, 0, width, height);
    const imageData = cvCtx.getImageData(0, 0, width, height);
    
    const features = detectGeologicalFeatures(imageData, width, height);
    const waterGaps = features.filter(f => f.type === "Water-Bearing Gap");
    
    let bestBorewellX = width / 2;
    let recommendedZone = waterGaps.find(f => f.recommended);
    if (recommendedZone) {
      bestBorewellX = recommendedZone.centroidX;
    } else if (waterGaps.length > 0) {
      bestBorewellX = waterGaps[0].centroidX;
      recommendedZone = waterGaps[0];
    }

    // --- SHARED HELPERS ---
    const scale = width / 1200;
    const fontStack = "Inter, Roboto, Arial, Helvetica, 'Segoe UI', sans-serif";

    // --- GEMINI SUMMARIZATION (text only, no drilling decisions) ---
    const cvSummary = features.map(f => `${f.id} (${f.type}): Area=${f.area}, DepthRange=${f.minY}px-${f.maxY}px, Score=${f.score}, Recommended=${f.recommended}`).join("\n");
    let geminiJson;
    
    try {
      const prompt = `Act as an expert PQWT geological reporter. 
      I have ALREADY run a deterministic Computer Vision pipeline. Here are the detected features:
      ${cvSummary}
      
      The CV Engine has selected the anomaly marked Recommended=true as the absolute Best Drilling Point. Do NOT question this.
      
      Return ONLY a JSON object matching this structure:
      {
        "location": "string",
        "confidence": "string (High, Medium, Low)",
        "ocrConfidence": "number (from 0 to 100)",
        "depthScale": [{ "yPixel": "number", "depthValue": "number" }],
        "originalProfileAnalysis": "string (Describe the visual profile generally)",
        "processedProfileAnalysis": "string (Summarize the detected CV features provided above. Explain why the highest scoring anomaly is a good drill point.)"
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

    // Calculate depths for all features
    const mappedFeatures = features.map(f => {
      const d1 = pixelToDepth(f.minY);
      const d2 = pixelToDepth(f.maxY);
      return {
        id: f.id,
        type: f.type,
        area: f.area,
        minX: f.minX, maxX: f.maxX, minY: f.minY, maxY: f.maxY,
        centroidX: f.centroidX, centroidY: f.centroidY,
        score: f.score,
        confidence: f.confidence,
        recommended: f.recommended,
        colorType: f.colorType,
        fillRatio: f.fillRatio,
        polygon: f.polygon,
        depthRange: (d1 !== -1 && d2 !== -1) ? `${d1}m - ${d2}m` : "Unavailable",
        widthInMeters: Math.round((f.maxX - f.minX) * 0.5) + "m"
      };
    });

    // --- GENERATE BINARY DETECTION MASK (debugging) ---
    const maskPixels = generateDetectionMask(imageData, width, height);
    const maskCanvas = createCanvas(width, height);
    const maskCtx = maskCanvas.getContext("2d");
    const maskImgData = maskCtx.createImageData(width, height);
    maskImgData.data.set(maskPixels);
    maskCtx.putImageData(maskImgData, 0, 0);
    const maskImageUrl = `data:image/png;base64,${maskCanvas.toBuffer("image/png").toString("base64")}`;

    // --- GENERATE PROCESSED DETECTION MAP (overlaid on original) ---
    const mapCanvas = createCanvas(width, height);
    const mapCtx = mapCanvas.getContext("2d");
    // Draw the original image as the base
    mapCtx.drawImage(canvasImage, 0, 0, width, height);
    
    // Draw semi-transparent color overlays for ALL features
    const overlayCanvas = createCanvas(width, height);
    const overlayCtx = overlayCanvas.getContext("2d");
    const overlayImgData = overlayCtx.createImageData(width, height);
    for (const f of features) {
      let r=0, g=0, b=0;
      if (f.colorType === "green") { r=34; g=197; b=94; }       // Soft Rock
      else if (f.colorType === "orange") { r=234; g=138; b=36; } // Hard Rock
      else if (f.colorType === "black") { r=30; g=64; b=175; }   // Water Gap (blue tint to stand out)
      
      for (let i = 0; i < f.points.length; i += 2) {
        const px = f.points[i];
        const py = f.points[i+1];
        const idx = (py * width + px) * 4;
        overlayImgData.data[idx] = r;
        overlayImgData.data[idx+1] = g;
        overlayImgData.data[idx+2] = b;
        overlayImgData.data[idx+3] = 100; // semi-transparent
      }
    }
    overlayCtx.putImageData(overlayImgData, 0, 0);
    mapCtx.drawImage(overlayCanvas, 0, 0);

    // Helper to draw ellipse
    const drawEllipse = (ctx2: any, cx: number, cy: number, rx: number, ry: number, color: string, lineW: number, dashed: boolean) => {
      ctx2.beginPath();
      ctx2.strokeStyle = color;
      ctx2.lineWidth = lineW;
      if (dashed) ctx2.setLineDash([10 * scale, 6 * scale]);
      if (typeof ctx2.ellipse === 'function') {
        ctx2.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
      } else {
        ctx2.save();
        ctx2.translate(cx, cy);
        ctx2.scale(1, ry / rx);
        ctx2.arc(0, 0, rx, 0, 2 * Math.PI);
        ctx2.restore();
      }
      ctx2.stroke();
      ctx2.setLineDash([]);
    };

    // Helper to draw a label badge
    const drawBadge = (ctx2: any, text: string, x: number, y: number, bgColor: string, fgColor: string) => {
      ctx2.font = `bold ${14 * scale}px ${fontStack}`;
      const tw = ctx2.measureText(text).width;
      const pad = 6 * scale;
      ctx2.fillStyle = bgColor;
      ctx2.fillRect(x - tw/2 - pad, y - 12 * scale, tw + pad * 2, 20 * scale);
      ctx2.fillStyle = fgColor;
      ctx2.fillText(text, x - tw/2, y + 3 * scale);
    };

    // Draw TIGHT dashed ellipses (clamped to 110% of bounding box) or contour outlines for irregular shapes
    for (const f of features) {
      const bw = f.maxX - f.minX + 1;
      const bh = f.maxY - f.minY + 1;
      const cx = f.minX + bw / 2;
      const cy = f.minY + bh / 2;

      // Clamp radii to max 110% of half-bounding-box (NEVER oversized)
      const maxRx = (bw / 2) * 1.10;
      const maxRy = (bh / 2) * 1.10;
      const rx = Math.min(Math.max(bw / 2, 8 * scale), maxRx);
      const ry = Math.min(Math.max(bh / 2, 8 * scale), maxRy);

      let ellipseColor = "rgba(34, 197, 94, 0.9)";
      let badgeBg = "rgba(34,197,94,0.85)";
      if (f.colorType === "orange") { ellipseColor = "rgba(234,138,36,0.9)"; badgeBg = "rgba(234,138,36,0.85)"; }
      if (f.colorType === "black") { ellipseColor = "rgba(255,255,0,1)"; badgeBg = "rgba(30,64,175,0.9)"; }
      if (f.recommended) { ellipseColor = "rgba(255,50,50,1)"; badgeBg = "rgba(220,38,38,0.95)"; }

      // If it's a water gap or highly irregular, draw its tight concave polygon outline
      if (f.type === "Water-Bearing Gap" || f.fillRatio < 0.6) {
        if (f.polygon && f.polygon.length >= 6) {
          mapCtx.beginPath();
          mapCtx.moveTo(f.polygon[0], f.polygon[1]);
          for (let i = 2; i < f.polygon.length; i += 2) {
            mapCtx.lineTo(f.polygon[i], f.polygon[i+1]);
          }
          mapCtx.closePath();
          mapCtx.strokeStyle = ellipseColor;
          mapCtx.lineWidth = (f.recommended ? 5 : 3) * scale;
          mapCtx.setLineDash([8 * scale, 6 * scale]);
          mapCtx.stroke();
          mapCtx.setLineDash([]);
        }
        
        // Only draw a small reference ellipse if it's really small
        if (f.area < 1000) {
          drawEllipse(mapCtx, cx, cy, rx, ry, ellipseColor.replace('1)', '0.5)'), 2 * scale, true);
        }
      } else {
        // Regular soft/hard rock regions can still use clamped ellipses
        drawEllipse(mapCtx, cx, cy, rx, ry, ellipseColor, 3 * scale, true);
      }

      // ID + Type label above ellipse
      const typeShort = f.type === "Water-Bearing Gap" ? "Gap" : (f.type === "Soft Rock" ? "Soft" : "Hard");
      drawBadge(mapCtx, `${f.id} • ${typeShort}`, cx, cy - ry - 14 * scale, badgeBg, "#ffffff");

      // Confidence + Score below ellipse (only for water gaps)
      if (f.type === "Water-Bearing Gap") {
        drawBadge(mapCtx, `${f.confidence}% • Score: ${f.score}`, cx, cy + ry + 8 * scale, "rgba(0,0,0,0.75)", "#ffffff");
      }
    }

    // Draw drilling line + crosshair + label on PROCESSED MAP
    let bestDepthStr = "No reliable drilling point detected.";
    if (recommendedZone) {
      const bestDepth = pixelToDepth((recommendedZone.minY + recommendedZone.maxY)/2);
      if (bestDepth !== -1) bestDepthStr = `${bestDepth}m`;

      // Vertical green drilling line
      mapCtx.beginPath();
      mapCtx.strokeStyle = "rgba(0, 255, 0, 0.9)";
      mapCtx.lineWidth = 4 * scale;
      mapCtx.moveTo(bestBorewellX, height * 0.15);
      mapCtx.lineTo(bestBorewellX, height * 0.95);
      mapCtx.stroke();

      // Red crosshair at drilling point
      const targetY = (recommendedZone.minY + recommendedZone.maxY) / 2;
      mapCtx.beginPath();
      mapCtx.fillStyle = "rgba(255, 0, 0, 1)";
      mapCtx.arc(bestBorewellX, targetY, 5 * scale, 0, 2 * Math.PI);
      mapCtx.fill();

      mapCtx.beginPath();
      mapCtx.strokeStyle = "rgba(255, 0, 0, 1)";
      mapCtx.lineWidth = 3 * scale;
      mapCtx.arc(bestBorewellX, targetY, 16 * scale, 0, 2 * Math.PI);
      mapCtx.stroke();

      mapCtx.beginPath();
      mapCtx.strokeStyle = "rgba(255, 0, 0, 1)";
      mapCtx.lineWidth = 3 * scale;
      mapCtx.moveTo(bestBorewellX - 26 * scale, targetY);
      mapCtx.lineTo(bestBorewellX + 26 * scale, targetY);
      mapCtx.moveTo(bestBorewellX, targetY - 26 * scale);
      mapCtx.lineTo(bestBorewellX, targetY + 26 * scale);
      mapCtx.stroke();

      // BEST DRILLING POINT label
      mapCtx.font = `bold ${18 * scale}px ${fontStack}`;
      const labelText = "BEST DRILLING POINT";
      const textW = mapCtx.measureText(labelText).width;
      const boxW = textW + 32 * scale;
      const boxH = 40 * scale;
      let boxX = bestBorewellX + 30 * scale;
      if (boxX + boxW > width - 10 * scale) boxX = bestBorewellX - boxW - 30 * scale;
      const boxY = targetY - boxH / 2;
      
      mapCtx.fillStyle = "rgba(220, 38, 38, 0.95)";
      mapCtx.fillRect(boxX, boxY, boxW, boxH);
      mapCtx.fillStyle = "#ffffff";
      mapCtx.fillText(labelText, boxX + 16 * scale, boxY + 27 * scale);
    }
    
    const processedImageUrl = `data:image/png;base64,${mapCanvas.toBuffer("image/png").toString("base64")}`;

    // --- ANNOTATED IMAGE (original + drilling line only) ---
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(canvasImage, 0, 0, width, height);
    if (recommendedZone) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 255, 0, 0.9)";
      ctx.lineWidth = 4 * scale;
      ctx.moveTo(bestBorewellX, height * 0.15);
      ctx.lineTo(bestBorewellX, height * 0.95);
      ctx.stroke();
      const targetY = (recommendedZone.minY + recommendedZone.maxY) / 2;
      ctx.beginPath(); ctx.fillStyle = "red"; ctx.arc(bestBorewellX, targetY, 5*scale, 0, 2*Math.PI); ctx.fill();
      ctx.beginPath(); ctx.strokeStyle = "red"; ctx.lineWidth = 3*scale; ctx.arc(bestBorewellX, targetY, 16*scale, 0, 2*Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.strokeStyle = "red"; ctx.lineWidth = 3*scale;
      ctx.moveTo(bestBorewellX-26*scale, targetY); ctx.lineTo(bestBorewellX+26*scale, targetY);
      ctx.moveTo(bestBorewellX, targetY-26*scale); ctx.lineTo(bestBorewellX, targetY+26*scale);
      ctx.stroke();
    }
    const annotatedImageUrl = `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;

    // Return the extended JSON
    geminiJson.bestBorewellPoint = { depth: bestDepthStr };
    geminiJson.recommendedDrillingDepth = bestDepthStr;

    return NextResponse.json({ 
      success: true, 
      reportData: {
        customerName,
        originalImage: originalImageUrl,
        maskImage: maskImageUrl,
        processedImage: processedImageUrl,
        annotatedImage: annotatedImageUrl,
        features: mappedFeatures,
        geminiData: geminiJson
      }
    });

  } catch (error: any) {
    console.error("Upload API Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
