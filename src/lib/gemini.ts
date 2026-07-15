import { GoogleGenerativeAI } from "@google/generative-ai";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


function isRetriableError(error: any): boolean {
  if (!error) return false;
  const errorStr = error.toString().toLowerCase();
  
  // HTTP 429 (quota exceeded), HTTP 503 (service unavailable), rate limiting, network errors, timeout, overloaded
  if (
    errorStr.includes("429") || 
    errorStr.includes("503") || 
    errorStr.includes("quota") || 
    errorStr.includes("rate limit") || 
    errorStr.includes("network") || 
    errorStr.includes("timeout") || 
    errorStr.includes("overloaded") || 
    errorStr.includes("unavailable") ||
    errorStr.includes("fetch failed")
  ) {
    return true;
  }
  return false;
}

export async function generateWithFailover(prompt: string, inlineData: any): Promise<any> {
  const keysToTry = Object.keys(process.env)
    .filter(k => k.startsWith("GEMINI_API_KEY"))
    .map(k => ({ key: process.env[k], name: k }))
    .filter(k => !!k.key);

  if (keysToTry.length === 0) {
    throw new Error("No Gemini API keys configured. Please set GEMINI_API_KEY_1 in .env.local.");
  }

  // Fallback chain for models.
  const modelsToTry = ["gemini-2.5-flash", "gemini-2.5-pro"];

  let lastError: any = null;

  for (const currentKeyInfo of keysToTry) {
    for (const modelName of modelsToTry) {
      console.log(`[Gemini Service] Attempting ${modelName} on ${currentKeyInfo.name}...`);
      
      const genAI = new GoogleGenerativeAI(currentKeyInfo.key as string);
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        generationConfig: {
          temperature: 0,
          topK: 1,
          topP: 0,
        }
      });

      // Exponential backoff strategy per model
      const backoffDelays = [0, 2000, 4000, 8000]; 

      for (let attempt = 0; attempt < backoffDelays.length; attempt++) {
        try {
          if (backoffDelays[attempt] > 0) {
            console.log(`[Gemini Service] Backoff waiting ${backoffDelays[attempt]}ms...`);
            await delay(backoffDelays[attempt]);
          }

          const result = await model.generateContent([
            prompt,
            {
              inlineData: inlineData
            }
          ]);
          
          console.log(`[Gemini Service] Success using ${modelName} on ${currentKeyInfo.name}`);
          return result.response.text();
        } catch (error: any) {
          lastError = error;
          
          if (!isRetriableError(error)) {
            console.warn(`[Gemini Service] Non-retriable error encountered on ${modelName} using ${currentKeyInfo.name}. Switching model/keys if available.`);
            break; // Break out of the backoff loop, try next model/key
          }
          
          console.warn(`[Gemini Service] Retriable error on ${modelName} using ${currentKeyInfo.name} (Attempt ${attempt + 1}).`);
        }
      }
    }
  }

  throw new Error(`Failed to generate content after trying all available API keys and models. Please try again later. Last error: ${lastError?.message || "Unknown error"}`);
}

export function repairAndParseJSON(jsonString: string): any {
  let cleaned = jsonString.trim();
  // Remove markdown blocks if present
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json/, "");
  }
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```/, "");
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.replace(/```$/, "");
  }
  cleaned = cleaned.trim();
  
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.warn("Initial JSON parse failed, attempting repairs...");
    
    // Fix missing quotes around keys
    let repaired = cleaned.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2": ');
    
    // Fix trailing commas
    repaired = repaired.replace(/,\s*([\]}])/g, "$1");
    
    try {
      return JSON.parse(repaired);
    } catch (finalError) {
      console.error("JSON repair failed completely.");
      throw new Error("Failed to parse Gemini response as valid JSON.");
    }
  }
}
