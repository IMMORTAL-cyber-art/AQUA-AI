import { ImageData } from "@napi-rs/canvas";
import concaveman from "concaveman";

export interface GeologicalFeature {
  id: string;
  type: "Water-Bearing Gap";
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
  score: number;
  confidence: number;
  recommended: boolean;
  colorType: string;
  polygon: number[];
  priority: number;
  softRockIntersection: boolean;
  hardRockAbove: boolean;
  verticalThickness: number;
}

export interface VisionResult {
  waterZones: GeologicalFeature[];
  pixelMap: Uint8Array;
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

// Optimized 3x3 Morphology
function dilate3x3(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    let rowStart = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowStart + x;
      if (mask[idx]) {
        out[idx] = 1; out[idx - 1] = 1; out[idx + 1] = 1;
        out[idx - width] = 1; out[idx - width - 1] = 1; out[idx - width + 1] = 1;
        out[idx + width] = 1; out[idx + width - 1] = 1; out[idx + width + 1] = 1;
      }
    }
  }
  return out;
}

function erode3x3(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    let rowStart = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowStart + x;
      if (
        mask[idx] && mask[idx - 1] && mask[idx + 1] &&
        mask[idx - width] && mask[idx - width - 1] && mask[idx - width + 1] &&
        mask[idx + width] && mask[idx + width - 1] && mask[idx + width + 1]
      ) {
        out[idx] = 1;
      }
    }
  }
  return out;
}

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number): VisionResult {
  const data = imageData.data;
  const startY = Math.round(height * 0.15); // Skip surface noise/header
  const totalPixels = width * height;
  
  const pixelMap = new Uint8Array(totalPixels); // 0=Bg, 1=Soft(Green), 2=Hard(Orange)
  const initialGapMask = new Uint8Array(totalPixels);
  
  // STEP 1: Segment Image (Classify Context vs Water Gaps strictly)
  for (let y = startY; y < height; y++) {
    let rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);

      // Water Gap classification (Strictly Blue or Black)
      // Ignore Orange/Yellow completely
      const isBlue = (h >= 170 && h <= 280 && s > 20); // Light blue to dark blue
      const isBlack = (l < 20); // Very dark regions (enclosed cavities)

      if (isBlue || isBlack) {
        initialGapMask[idx] = 1;
      } 
      // Context classification
      else if (h >= 70 && h <= 160 && s > 15 && l > 15) {
        pixelMap[idx] = 1; // Soft Rock (Green)
      } 
      else if ((h >= 10 && h <= 65 || h > 330) && s > 20 && l > 15) {
        pixelMap[idx] = 2; // Hard Rock (Orange/Red/Yellow)
      }
    }
  }

  // STEP 2 & 3: Remove grid lines and text using morphology (Opening)
  // Erode heavily to kill 1px and 2px thick lines/fonts
  let mask = erode3x3(initialGapMask, width, height);
  mask = erode3x3(mask, width, height); 
  mask = dilate3x3(mask, width, height);
  mask = dilate3x3(mask, width, height);
  
  // STEP 4 & 5: Find enclosed cavities & Merge touching cavities (Closing)
  // Dilate to bridge small gaps between related cavity pockets
  for(let i=0; i<4; i++) mask = dilate3x3(mask, width, height);
  for(let i=0; i<4; i++) mask = erode3x3(mask, width, height);

  const visited = new Uint8Array(totalPixels);
  const rawGaps: any[] = [];
  
  const borderMargin = Math.round(width * 0.05);
  const minArea = width * height * 0.001; // Reject tiny noise
  const maxArea = width * height * 0.20;  // STEP 8: Reject contours > 20% of image

  for (let y = startY; y < height; y++) {
    let rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      if (visited[idx] || mask[idx] !== 1) continue;
      
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;
      
      let area = 0, minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;
      const points: number[] = [];
      let qHead = 0;
      let touchesBorder = false;

      while (qHead < queue.length) {
        const [cx, cy] = queue[qHead++];
        points.push(cx, cy);
        area++;
        sumX += cx; sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // STEP 7: Check border touching
        if (cx <= borderMargin || cx >= width - borderMargin || cy >= height - borderMargin) {
          touchesBorder = true;
        }

        for (let ny = cy - 1; ny <= cy + 1; ny++) {
          for (let nx = cx - 1; nx <= cx + 1; nx++) {
            if (nx >= 0 && nx < width && ny >= startY && ny < height) {
              const nIdx = ny * width + nx;
              if (!visited[nIdx] && mask[nIdx] === 1) {
                visited[nIdx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
        }
      }

      const verticalThickness = maxY - minY;
      const horizontalWidth = maxX - minX;

      // STEP 6: Reject long thin contours
      const isTooThin = (verticalThickness < height * 0.02) || (horizontalWidth > verticalThickness * 10);
      
      // STEP 9: Reject orange-only and green-only regions
      // By definition, our initialGapMask ONLY contained Blue and Black pixels.
      // So no purely Orange/Green regions will ever be detected as Water Zones.

      if (!touchesBorder && area >= minArea && area <= maxArea && !isTooThin) {
        // Analyze surrounding geological context
        let softRockCount = 0;
        let hardRockCount = 0;
        let hardRockAboveCount = 0;
        
        // Context search area (slightly expanded bounding box)
        const searchMinX = Math.max(0, minX - 10);
        const searchMaxX = Math.min(width - 1, maxX + 10);
        const searchMinY = Math.max(startY, minY - 30);
        const searchMaxY = Math.min(height - 1, maxY + 10);
        
        for (let sy = searchMinY; sy <= searchMaxY; sy++) {
          let sRowStart = sy * width;
          for (let sx = searchMinX; sx <= searchMaxX; sx++) {
            const ctxType = pixelMap[sRowStart + sx];
            if (ctxType === 1) softRockCount++;
            if (ctxType === 2) {
              hardRockCount++;
              if (sy < minY) hardRockAboveCount++;
            }
          }
        }

        rawGaps.push({ 
          area, minX, maxX, minY, maxY, sumX, sumY, points,
          softRockCount, hardRockCount, hardRockAboveCount, verticalThickness
        });
      }
    }
  }

  // STEP 10: Remaining enclosed anomalies become Water Zones
  const waterZones: GeologicalFeature[] = [];

  for (const gap of rawGaps) {
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(gap.points.length / 1000));
    for (let i = 0; i < gap.points.length; i += 2 * step) {
      hullPoints.push([gap.points[i], gap.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 2, 0.005);
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    // DRILL DECISION SCORING
    const depthScore = Math.max(0, 1 - (gap.minY / height)) * 1000; 
    const sizeScore = (gap.area / (width * height)) * 50000;
    const thicknessScore = (gap.verticalThickness / height) * 2000;
    const softRockBonus = (gap.softRockCount > 100) ? 500 : 0;
    const hardRockPenalty = (gap.hardRockAboveCount > 300) ? -1000 : 0;

    const score = Math.round(depthScore + sizeScore + thicknessScore + softRockBonus + hardRockPenalty);

    waterZones.push({
      id: "", // Assigned later
      type: "Water-Bearing Gap",
      area: gap.area,
      minX: gap.minX, maxX: gap.maxX, minY: gap.minY, maxY: gap.maxY,
      centroidX: gap.sumX / gap.area,
      centroidY: gap.sumY / gap.area,
      score,
      confidence: Math.min(100, Math.floor(70 + (gap.softRockCount > 0 ? 15 : 0) + (gap.area > width*height*0.02 ? 15 : 0))),
      recommended: false,
      colorType: "black",
      polygon: flatHull,
      priority: 0,
      softRockIntersection: gap.softRockCount > 100,
      hardRockAbove: gap.hardRockAboveCount > 300,
      verticalThickness: gap.verticalThickness
    });
  }

  // Sort by score descending to assign priorities
  waterZones.sort((a, b) => b.score - a.score);
  
  // Assign numbering and recommendations
  waterZones.forEach((z, idx) => {
    z.id = `Water Zone ${idx + 1}`;
    z.priority = idx + 1;
    if (idx === 0) z.recommended = true;
  });

  // Blend the mask into pixelMap for rendering Processed Map
  for (let i = 0; i < totalPixels; i++) {
    if (mask[i] === 1) {
      pixelMap[i] = 3;
    }
  }

  return { waterZones, pixelMap };
}
