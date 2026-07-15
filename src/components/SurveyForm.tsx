"use client";
import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useRouter } from "next/navigation";
import { useLanguage } from "./LanguageContext";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Progress } from "./ui/progress";
import { LanguageSwitcher } from "./LanguageSwitcher";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const formSchema = z.object({
  customerName: z.string().min(2, "Name must be at least 2 characters"),
  image: z
    .any()
    .refine((files) => files?.length === 1, "Image is required.")
    .refine((files) => files?.[0]?.size <= MAX_FILE_SIZE, `Max file size is 20MB.`)
    .refine(
      (files) => ACCEPTED_IMAGE_TYPES.includes(files?.[0]?.type),
      "Only .jpg, .jpeg, .png and .webp formats are supported."
    ),
});

export function SurveyForm({ onSuccess }: { onSuccess: (data: any) => void }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      setIsUploading(true);
      setError(null);
      setProgress(10);
      
      const formData = new FormData();
      formData.append("customerName", values.customerName);
      formData.append("image", values.image[0]);

      setProgress(40);

      const response = await fetch("/api/upload-and-analyze", {
        method: "POST",
        body: formData,
      });

      setProgress(80);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to process image");
      }

      const data = await response.json();
      setProgress(100);
      
      // Pass data to parent instead of redirecting
      onSuccess(data.reportData);
    } catch (err: any) {
      console.error("Upload error:", err);
      let errorMessage = err.message || "An unexpected error occurred";
      
      // Friendly messages for common API errors
      if (errorMessage.includes("503") || errorMessage.includes("Service Unavailable") || errorMessage.includes("high demand")) {
         errorMessage = "The AI model is currently experiencing high demand. Please try again in a few moments.";
      } else if (errorMessage.includes("429") || errorMessage.includes("quota")) {
         errorMessage = "The AI service is temporarily overloaded. Please try again shortly.";
      }
      
      setError(errorMessage);
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="absolute top-4 right-4 flex gap-4 items-center">
        <a href="/settings" className="text-sm font-medium text-slate-600 hover:text-blue-600">Settings</a>
        <LanguageSwitcher />
      </div>

      <Card className="w-full max-w-md shadow-lg border-t-4 border-t-blue-600">
        <CardHeader className="text-center pb-8">
          <CardTitle className="text-3xl font-bold text-slate-800">{t("title")}</CardTitle>
          <CardDescription className="text-slate-500 mt-2">{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="customerName" className="text-sm font-semibold text-slate-700">
                {t("customerName")}
              </Label>
              <Input
                id="customerName"
                placeholder="John Doe"
                className="w-full"
                {...register("customerName")}
                disabled={isUploading}
              />
              {errors.customerName && (
                <p className="text-sm text-red-500">{errors.customerName.message as string}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="image" className="text-sm font-semibold text-slate-700">
                {t("uploadImage")}
              </Label>
              <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 flex flex-col items-center justify-center bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer">
                <input
                  id="image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="w-full cursor-pointer text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                  {...register("image")}
                  disabled={isUploading}
                />
                <p className="text-xs text-slate-400 mt-4 text-center">
                  {t("maxSize")}
                </p>
              </div>
              {errors.image && (
                <p className="text-sm text-red-500">{errors.image.message as string}</p>
              )}
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-md text-sm">
                {error}
              </div>
            )}

            {isUploading && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{t("analyzing")}</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} className="w-full h-2" />
              </div>
            )}

            <Button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-6 rounded-lg transition-all"
              disabled={isUploading}
            >
              {isUploading ? t("analyzing") : t("submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
