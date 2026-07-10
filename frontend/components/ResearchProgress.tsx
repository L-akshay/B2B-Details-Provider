const STAGES: Array<[string, string]> = [
  ['searching', 'Searching the web, registries & news'],
  ['scraping', 'Reading the company website'],
  ['harvesting_contacts', 'Collecting & verifying contact details'],
  ['extracting', 'Extracting data (two independent AI passes)'],
  ['reconciling', 'Cross-checking passes & scoring confidence'],
  ['generating_report', 'Generating the DOCX report'],
];

export default function ResearchProgress({ stage }: { stage: string | null }) {
  const currentIndex = STAGES.findIndex(([key]) => key === stage);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
        <span className="text-sm font-medium text-slate-700">Researching…</span>
      </div>
      <ol className="mt-4 space-y-1.5">
        {STAGES.map(([key, label], index) => {
          const isDone = currentIndex > index;
          const isActive = currentIndex === index;
          return (
            <li
              key={key}
              className={`flex items-center gap-2 text-sm ${
                isActive ? 'font-medium text-slate-900' : isDone ? 'text-slate-400 line-through' : 'text-slate-400'
              }`}
            >
              <span>{isDone ? '✓' : isActive ? '›' : '·'}</span>
              {label}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-xs text-slate-400">
        Typically takes 1–3 minutes — multiple sources and AI passes run per request.
      </p>
    </div>
  );
}
