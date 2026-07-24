import { ImageData } from "@napi-rs/canvas";
import concaveman from "concaveman";

export interface GeologicalFeature {
  id: string;
  type: "Water Zone";
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
  verticalThickness: number;
  horizontalWidth: number;
  rockAbove: string;
  rockBelow: string;
  rockSurrounding: string;
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

function boxBlur(gray: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(gray.length);
  const temp = new Float32Array(gray.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const rowStart = y * width;
    for (let x = -radius; x <= radius; x++) sum += gray[rowStart + Math.max(0, Math.min(width - 1, x))];
    temp[rowStart] = sum;
    for (let x = 1; x < width; x++) {
      sum += gray[rowStart + Math.min(width - 1, x + radius)] - gray[rowStart + Math.max(0, x - radius - 1)];
      temp[rowStart + x] = sum;
    }
  }
  const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += temp[Math.max(0, Math.min(height - 1, y)) * width + x];
    out[x] = sum / windowSize;
    for (let y = 1; y < height; y++) {
      sum += temp[Math.min(height - 1, y + radius) * width + x] - temp[Math.max(0, y - radius - 1) * width + x];
      out[y * width + x] = sum / windowSize;
    }
  }
  return out;
}

function sobelEdges(gray: Float32Array, width: number, height: number, threshold: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const row0 = (y - 1) * width;
    const row1 = y * width;
    const row2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const gx = 
        -1 * gray[row0 + x - 1] + 1 * gray[row0 + x + 1] +
        -2 * gray[row1 + x - 1] + 2 * gray[row1 + x + 1] +
        -1 * gray[row2 + x - 1] + 1 * gray[row2 + x + 1];
      const gy = 
        -1 * gray[row0 + x - 1] - 2 * gray[row0 + x] - 1 * gray[row0 + x + 1] +
         1 * gray[row2 + x - 1] + 2 * gray[row2 + x] + 1 * gray[row2 + x + 1];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > threshold) edges[row1 + x] = 1;
    }
  }
  return edges;
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      if (mask[idx] === 1) {
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const nRowStart = ny * width;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            out[nRowStart + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      let allOne = true;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          allOne = false;
          break;
        }
        const nRowStart = ny * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || mask[nRowStart + nx] === 0) {
            allOne = false;
            break;
          }
        }
        if (!allOne) break;
      }
      if (allOne) {
        out[idx] = 1;
      }
    }
  }
  return out;
}

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number): VisionResult {
  const data = imageData.data;
  const totalPixels = width * height;
  
  // STEP 1: Crop the profile area. Remove borders, labels, margins.
  const marginX = Math.round(width * 0.08);
  const marginYTop = Math.round(height * 0.15);
  const marginYBot = Math.round(height * 0.08);
  
  const startX = marginX;
  const endX = width - marginX;
  const startY = marginYTop;
  const endY = height - marginYBot;

  const gray = new Float32Array(totalPixels);
  const pixelMap = new Uint8Array(totalPixels); // 0=Bg, 1=Soft(Green), 2=Hard(Orange), 3=Dark/Gap(Black/Blue)
  
  // Create color map strictly inside the cropped geological profile region.
  // Pixels outside the crop region remain 0 (Background) so page margins/text are not colored.
  for (let y = startY; y < endY; y++) {
    let rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      
      gray[idx] = 0.299 * r + 0.587 * g + 0.114 * b;
      
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l < 20 || (h >= 170 && h <= 280 && s > 20)) {
        pixelMap[idx] = 3; // Black / Dark Blue / Light Blue (Water gap context)
      } else {
        // Any non-water pixel inside is rock. Classify by Hue to green or orange rock.
        if (h >= 70 && h <= 170) {
          pixelMap[idx] = 1; // Green (Soft Rock)
        } else {
          pixelMap[idx] = 2; // Orange (Hard Rock)
        }
      }
    }
  }

  // Create binary mask of blue/water pixels inside the cropped region
  const blueMask = new Uint8Array(totalPixels);
  for (let y = startY; y < endY; y++) {
    const rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      if (pixelMap[idx] === 3) {
        blueMask[idx] = 1;
      }
    }
  }

  // Morphological Closing: dilation followed by erosion (radius=2)
  console.log("[Morphological Closing] Performing closing on blue water mask...");
  const dilated = dilate(blueMask, width, height, 2);
  const closedMask = erode(dilated, width, height, 2);

  // STEP 3: Extract connected anomaly components (BFS)
  const visited = new Uint8Array(totalPixels);
  const validCavities: any[] = [];

  const cropWidth = endX - startX;
  const cropHeight = endY - startY;

  for (let y = startY; y < endY; y++) {
    const rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      if (visited[idx] || closedMask[idx] === 0) continue;

      // Start BFS
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;
      let qHead = 0;
      
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;
      let enclosedArea = 0;
      let cavitySize = 0;
      const points: number[] = [];
      const componentPixels = new Set<number>();

      while (qHead < queue.length) {
        const [cx, cy] = queue[qHead++];
        const cIdx = cy * width + cx;
        points.push(cx, cy);
        componentPixels.add(cIdx);
        enclosedArea++;
        if (blueMask[cIdx] === 1) {
          cavitySize++;
        }
        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let i = 0; i < 4; i++) {
          const nx = neighbors[i][0];
          const ny = neighbors[i][1];
          if (nx >= startX && nx < endX && ny >= startY && ny < endY) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx] && closedMask[nIdx] === 1) {
              visited[nIdx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      const centroidX = sumX / enclosedArea;
      const centroidY = sumY / enclosedArea;
      const verticalThickness = maxY - minY;
      const horizontalWidth = maxX - minX;

      // RULE 3: Remove tiny connected components below a minimum area threshold
      if (enclosedArea < 300) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: tiny area (${enclosedArea} < 300)`);
        continue;
      }

      // RULE 1: Ignore every connected blue component touching the image border of the ENTIRE image
      const touchesImageBorder = (minX <= 3 || maxX >= width - 4 || minY <= 3 || maxY >= height - 4);
      if (touchesImageBorder) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: touches absolute image border (minX: ${minX}, maxX: ${maxX}, minY: ${minY}, maxY: ${maxY})`);
        continue;
      }

      // RULE 2: Ignore the continuous bottom blue layer completely
      const isBottomLayer = (maxY > endY - 30 && horizontalWidth > cropWidth * 0.50);
      if (isBottomLayer) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: bottom blue layer (Width: ${horizontalWidth}, maxY: ${maxY})`);
        continue;
      }

      // RULE 4: A valid water cavity must be fully enclosed by orange and/or green rock (allowing left/right crop edge expansion)
      let isFullyEnclosed = true;
      for (const cIdx of componentPixels) {
        const cx = cIdx % width;
        const cy = Math.floor(cIdx / width);
        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let n = 0; n < 4; n++) {
          const nx = neighbors[n][0];
          const ny = neighbors[n][1];
          
          // Enclosure constraint for top and bottom of crop area
          if (ny < startY || ny >= endY) {
            isFullyEnclosed = false;
            break;
          }
          
          // Allow extending/truncating at the left/right crop edges
          if (nx < startX || nx >= endX) {
            continue;
          }
          
          const nIdx = ny * width + nx;
          if (!componentPixels.has(nIdx)) {
            const neighborColor = pixelMap[nIdx];
            if (neighborColor !== 1 && neighborColor !== 2) {
              isFullyEnclosed = false;
              break;
            }
          }
        }
        if (!isFullyEnclosed) break;
      }

      if (!isFullyEnclosed) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: not fully enclosed by orange/green rock`);
        continue;
      }

      validCavities.push({
        enclosedArea,
        cavitySize,
        minX,
        maxX,
        minY,
        maxY,
        centroidX,
        centroidY,
        verticalThickness,
        horizontalWidth,
        points
      });
    }
  }

  // STEP 4: Merge nearby cavities belonging to the same fracture
  console.log(`[Debug Log] Unmerged valid cavities: ${validCavities.length}`);
  const mergedCavities: any[] = [];
  const cavityMerged = new Array(validCavities.length).fill(false);
  const mergeThreshold = height * 0.06; // 6% height distance

  for (let i = 0; i < validCavities.length; i++) {
    if (cavityMerged[i]) continue;
    let merged = { ...validCavities[i], points: [...validCavities[i].points] };
    cavityMerged[i] = true;

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < validCavities.length; j++) {
        if (!cavityMerged[j]) {
          const target = validCavities[j];
          const xOverlap = Math.max(0, Math.min(merged.maxX, target.maxX) - Math.max(merged.minX, target.minX));
          const yDist = Math.max(0, Math.max(merged.minY, target.minY) - Math.min(merged.maxY, target.maxY));
          
          if (xOverlap > 0 && yDist < mergeThreshold) {
            merged.points.push(...target.points);
            merged.enclosedArea += target.enclosedArea;
            merged.cavitySize += target.cavitySize;
            merged.minX = Math.min(merged.minX, target.minX);
            merged.maxX = Math.max(merged.maxX, target.maxX);
            merged.minY = Math.min(merged.minY, target.minY);
            merged.maxY = Math.max(merged.maxY, target.maxY);
            merged.centroidX = (merged.centroidX * (merged.enclosedArea - target.enclosedArea) + target.centroidX * target.enclosedArea) / merged.enclosedArea;
            merged.centroidY = (merged.centroidY * (merged.enclosedArea - target.enclosedArea) + target.centroidY * target.enclosedArea) / merged.enclosedArea;
            merged.verticalThickness = merged.maxY - merged.minY;
            merged.horizontalWidth = merged.maxX - merged.minX;
            cavityMerged[j] = true;
            changed = true;
          }
        }
      }
    }
    mergedCavities.push(merged);
  }

  // STEP 5: Rank and evaluate all merged cavities (drilling corridors)
  const maxPossibleArea = cropWidth * cropHeight;
  const maxPossibleThickness = cropHeight;
  const maxPossibleDistance = Math.min(cropWidth / 2, cropHeight / 2);

  const scoredCorridors = mergedCavities.map(c => {
    const distanceFromBorder = Math.min(c.minX - startX, endX - c.maxX, c.minY - startY, endY - c.maxY);

    const normEnclosedArea = (c.enclosedArea / maxPossibleArea) * 100;
    const normCavitySize = (c.cavitySize / maxPossibleArea) * 100;
    const normVerticalContinuity = (c.verticalThickness / maxPossibleThickness) * 100;
    const normDistanceFromBorder = (distanceFromBorder / maxPossibleDistance) * 100;

    // score = 40% enclosed area, 30% cavity size, 20% vertical continuity, 10% distance from border
    const score = 0.4 * normEnclosedArea + 0.3 * normCavitySize + 0.2 * normVerticalContinuity + 0.1 * normDistanceFromBorder;

    return {
      ...c,
      distanceFromBorder,
      normEnclosedArea,
      normCavitySize,
      normVerticalContinuity,
      normDistanceFromBorder,
      score
    };
  });

  scoredCorridors.sort((a, b) => b.score - a.score);

  console.log(`[Debug Log] Total valid merged cavities detected: ${scoredCorridors.length}`);
  
  scoredCorridors.forEach((c, idx) => {
    console.log(`- Cavity #${idx + 1}: Y: ${c.minY}-${c.maxY} (X: ${c.minX}-${c.maxX}), Centroid: (${c.centroidX.toFixed(1)}, ${c.centroidY.toFixed(1)})`);
    console.log(`  * Enclosed Area (closing): ${c.enclosedArea} (normalized: ${c.normEnclosedArea.toFixed(3)}%)`);
    console.log(`  * Cavity Size (original blue): ${c.cavitySize} (normalized: ${c.normCavitySize.toFixed(3)}%)`);
    console.log(`  * Vertical Continuity (thickness): ${c.verticalThickness} (normalized: ${c.normVerticalContinuity.toFixed(3)}%)`);
    console.log(`  * Distance From Border: ${c.distanceFromBorder} (normalized: ${c.normDistanceFromBorder.toFixed(3)}%)`);
    console.log(`  * Final Score: ${c.score.toFixed(3)}`);
  });

  const waterZones: GeologicalFeature[] = [];

  // Requirements: Select ONLY ONE Best Drilling Point (at most 1 waterZone).
  if (scoredCorridors.length > 0) {
    const c = scoredCorridors[0];

    // Rock above search top block
    let hardAbove = 0, softAbove = 0;
    const searchTop = Math.max(startY, c.minY - 40);
    for (let y = searchTop; y < c.minY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const type = pixelMap[y * width + x];
        if (type === 2) hardAbove++;
        if (type === 1) softAbove++;
      }
    }

    // Rock surrounding search 30px boundary
    let softSurrounding = 0;
    let hardSurrounding = 0;
    const margin = 30;
    const sMinX = Math.max(startX, c.minX - margin);
    const sMaxX = Math.min(endX - 1, c.maxX + margin);
    const sMinY = Math.max(startY, c.minY - margin);
    const sMaxY = Math.min(endY - 1, c.maxY + margin);

    for (let y = sMinY; y <= sMaxY; y++) {
      for (let x = sMinX; x <= sMaxX; x++) {
        const type = pixelMap[y * width + x];
        if (type === 1) softSurrounding++;
        if (type === 2) hardSurrounding++;
      }
    }

    // Rock inside count
    let softCount = 0;
    let hardCount = 0;
    for (let i = 0; i < c.points.length; i += 2) {
      const type = pixelMap[c.points[i+1] * width + c.points[i]];
      if (type === 1) softCount++;
      if (type === 2) hardCount++;
    }
    softSurrounding = Math.max(0, softSurrounding - softCount);
    hardSurrounding = Math.max(0, hardSurrounding - hardCount);

    // Concave hull points
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(c.points.length / 500));
    for (let i = 0; i < c.points.length; i += 2 * step) {
      hullPoints.push([c.points[i], c.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 1, 10);
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    waterZones.push({
      id: "Water Zone 1",
      type: "Water Zone",
      area: c.enclosedArea, 
      minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY,
      centroidX: c.centroidX,
      centroidY: c.centroidY,
      score: c.score,
      confidence: Math.min(100, Math.floor(65 + (softCount/c.enclosedArea)*20 + (c.verticalThickness/height)*20)),
      recommended: true,
      colorType: "black",
      polygon: flatHull,
      priority: 1,
      verticalThickness: c.verticalThickness,
      horizontalWidth: c.horizontalWidth,
      rockAbove: hardAbove > softAbove ? "Hard Rock" : (softAbove > hardAbove ? "Soft Rock" : "Mixed"),
      rockBelow: "Unknown", 
      rockSurrounding: softCount > hardCount ? "Soft Rock Dominant" : "Hard Rock Dominant"
    });
  }

  if (waterZones.length === 0) {
    console.log(`[Debug Log] Best Drilling Point selected: None (No valid enclosed cavities detected)`);
  } else {
    const recommendedZone = waterZones[0];
    console.log(`[Debug Log] Best Drilling Point selected: ${recommendedZone.id} (Score: ${recommendedZone.score.toFixed(3)}, Centroid Y: ${recommendedZone.centroidY.toFixed(1)}, Depth pixel range: Y ${recommendedZone.minY}-${recommendedZone.maxY})`);
  }

  return { waterZones, pixelMap };
}
