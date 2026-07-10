'use client';

import { useState } from 'react';

interface ChatInputProps {
  disabled: boolean;
  onSubmit: (companyName: string, extraInfo: string) => void;
}

export default function ChatInput({ disabled, onSubmit }: ChatInputProps) {
  const [companyName, setCompanyName] = useState('');
  const [extraInfo, setExtraInfo] = useState('');
  const [showExtra, setShowExtra] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (companyName.trim().length < 2 || disabled) return;
    onSubmit(companyName.trim(), extraInfo);
  };

  return (
    <form onSubmit={submit} className="w-full space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="Company name, e.g. Tata Consultancy Services"
          disabled={disabled}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100"
        />
        <button
          type="submit"
          disabled={disabled || companyName.trim().length < 2}
          className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {disabled ? 'Researching…' : 'Research'}
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowExtra((v) => !v)}
        className="text-xs text-slate-500 underline-offset-2 hover:underline"
      >
        {showExtra ? '− Hide extra context' : '+ Add extra context (city, industry, website…)'}
      </button>

      {showExtra && (
        <textarea
          value={extraInfo}
          onChange={(e) => setExtraInfo(e.target.value)}
          placeholder="Anything that helps disambiguate: city, industry, known website…"
          disabled={disabled}
          rows={2}
          className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100"
        />
      )}
    </form>
  );
}
