"use client";
import React from "react";
import { useLanguage } from "./LanguageContext";
import { Language } from "@/lib/translations";

export function LanguageSwitcher() {
  const { language, setLanguage } = useLanguage();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLanguage(e.target.value as Language);
  };

  return (
    <select
      value={language}
      onChange={handleLanguageChange}
      className="bg-white border border-slate-300 text-slate-700 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 shadow-sm"
    >
      <option value="en">English</option>
      <option value="kn">ಕನ್ನಡ (Kannada)</option>
      <option value="hi">हिन्दी (Hindi)</option>
      <option value="te">తెలుగు (Telugu)</option>
      <option value="ta">தமிழ் (Tamil)</option>
    </select>
  );
}
