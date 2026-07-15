import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function SettingsPage() {
  const isGeminiConfigured = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "dummy_key_for_now" && process.env.GEMINI_API_KEY !== "";

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-slate-800">Settings</h1>
          <Link href="/" className="text-blue-600 hover:underline">
            &larr; Back to Home
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>System Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center p-4 border rounded-lg bg-white">
              <div>
                <h3 className="font-semibold text-slate-800">Google Gemini API</h3>
                <p className="text-sm text-slate-500">
                  Required for AI image analysis. Configure in <code className="bg-slate-100 px-1 py-0.5 rounded">.env.local</code>.
                </p>
              </div>
              <div>
                {isGeminiConfigured ? (
                  <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                    Configured
                  </span>
                ) : (
                  <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm font-medium">
                    Missing
                  </span>
                )}
              </div>
            </div>

          </CardContent>
        </Card>
      </div>
    </div>
  );
}
