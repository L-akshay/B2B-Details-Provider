import type { CompanyReport } from '@/lib/api';
import DownloadButton from './DownloadButton';

const NOT_AVAILABLE = 'Not publicly available';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      <div className="space-y-2 text-sm text-slate-800">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const empty = !value || !value.trim() || value === NOT_AVAILABLE;
  const unverified = /\(unverified/i.test(value);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="w-32 shrink-0 text-slate-500">{label}</span>
      <span className={empty ? 'text-slate-400 italic' : ''}>
        {empty ? NOT_AVAILABLE : value}
        {unverified && <UnverifiedBadge />}
      </span>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="italic text-slate-400">{NOT_AVAILABLE}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
          {item}
        </span>
      ))}
    </div>
  );
}

function UnverifiedBadge() {
  return (
    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
      unverified
    </span>
  );
}

function SourceLink({ url }: { url: string }) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="ml-2 text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
    >
      source
    </a>
  );
}

function LinkField({ label, url }: { label: string; url: string }) {
  const valid = url && /^https?:\/\//.test(url);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="w-32 shrink-0 text-slate-500">{label}</span>
      {valid ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-blue-600 underline-offset-2 hover:underline"
        >
          {url}
        </a>
      ) : (
        <span className="italic text-slate-400">{NOT_AVAILABLE}</span>
      )}
    </div>
  );
}

function DebugDownloadButton({ debug }: { debug: unknown }) {
  if (!debug) return null;
  const download = () => {
    const blob = new Blob([JSON.stringify(debug, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'research-debug.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button
      type="button"
      onClick={download}
      className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
    >
      Debug JSON
    </button>
  );
}

export default function ReportView({
  report,
  docxUrl,
}: {
  report: CompanyReport;
  docxUrl: string | null;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{report.company_name}</h1>
        <div className="flex flex-wrap gap-2">
          <DebugDownloadButton debug={report.debug_json} />
          {docxUrl && <DownloadButton docxUrl={docxUrl} />}
        </div>
      </div>

      {report.description && report.description !== NOT_AVAILABLE && (
        <p className="text-sm leading-relaxed text-slate-600">{report.description}</p>
      )}

      {report.overview && report.overview.trim() && report.overview !== NOT_AVAILABLE && (
        <Section title="Company Profile">
          {report.overview
            .split(/\n{2,}|\n/)
            .filter((p) => p.trim())
            .map((paragraph, i) => (
              <p key={i} className="leading-relaxed">
                {paragraph.trim()}
              </p>
            ))}
        </Section>
      )}

      <Section title="Legal">
        <Field label="Legal name" value={report.legal_name} />
        <Field label="Tax / reg. ID" value={report.tax_id || report.registration_id || ''} />
        <Field label="LEI" value={report.legal_entity_id || ''} />
        <Field label="Jurisdiction" value={report.jurisdiction || ''} />
        <Field label="Parent company" value={report.parent_company || ''} />
        <Field label="Domain since" value={report.domain_registered} />
        <Field label="Registrar" value={report.registrar} />
      </Section>

      <Section title="Contact">
        <div>
          <span className="text-slate-500">Addresses</span>
          {report.addresses.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {report.addresses.map((address, i) => (
                <li key={i}>
                  {address.value}
                  {address.confidence === 'unverified' && <UnverifiedBadge />}
                  <SourceLink url={address.source_url} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="ml-2 italic text-slate-400">{NOT_AVAILABLE}</span>
          )}
        </div>
        <div>
          <span className="text-slate-500">Phones</span>
          {report.phones.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {report.phones.map((phone, i) => (
                <li key={i}>
                  {phone.value}
                  <SourceLink url={phone.source_url} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="ml-2 italic text-slate-400">{NOT_AVAILABLE}</span>
          )}
        </div>
        <div>
          <span className="text-slate-500">Emails</span>
          {report.emails.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {report.emails.map((email, i) => (
                <li key={i}>
                  {email.value}
                  {email.verified ? (
                    <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                      MX verified
                    </span>
                  ) : (
                    <UnverifiedBadge />
                  )}
                  <SourceLink url={email.source} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="ml-2 italic text-slate-400">{NOT_AVAILABLE}</span>
          )}
        </div>
      </Section>

      <Section title="Business">
        <Field label="Industry" value={report.industry} />
        <Field label="Founded" value={report.founded} />
        <Field label="Employees" value={report.employee_count} />
        <Field label="Certifications" value={(report.certifications ?? []).join(', ')} />
        <Field label="Funding" value={report.funding_and_financials} />
      </Section>

      <Section title="Market & Competition">
        <Field label="Business model" value={report.business_model} />
        <Field label="Customers" value={report.target_customers} />
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-32 shrink-0 text-slate-500">Markets</span>
          <Chips items={report.markets_served ?? []} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-32 shrink-0 text-slate-500">Competitors</span>
          <Chips items={report.competitors ?? []} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-32 shrink-0 text-slate-500">Clients/partners</span>
          <Chips items={report.notable_clients_partners ?? []} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-32 shrink-0 text-slate-500">Suppliers</span>
          <Chips items={report.suppliers ?? []} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-32 shrink-0 text-slate-500">Buyers</span>
          <Chips items={report.buyers ?? []} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-32 shrink-0 text-slate-500">Distributors</span>
          <Chips items={report.distributors ?? []} />
        </div>
      </Section>

      {(report.history ?? []).length > 0 && (
        <Section title="History & Milestones">
          <ul className="space-y-1">
            {(report.history ?? []).map((item, i) => (
              <li key={i}>
                {item.year && <span className="font-medium">{item.year} — </span>}
                {item.event}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(report.awards ?? []).length > 0 && (
        <Section title="Awards & Recognition">
          <ul className="list-inside list-disc space-y-1">
            {(report.awards ?? []).map((award, i) => (
              <li key={i}>{award}</li>
            ))}
          </ul>
        </Section>
      )}

      {(report.office_locations ?? []).length > 0 && (
        <Section title="Office Locations">
          <ul className="list-inside list-disc space-y-1">
            {(report.office_locations ?? []).map((office, i) => (
              <li key={i}>{office}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Products & Services">
        {(report.products_services ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {(report.products_services ?? []).map((item) => (
              <span key={item} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                {item}
              </span>
            ))}
          </div>
        ) : (
          <span className="italic text-slate-400">{NOT_AVAILABLE}</span>
        )}
      </Section>

      <Section title="Key People">
        {report.key_people.length > 0 ? (
          <ul className="space-y-1">
            {report.key_people.map((person, i) => (
              <li key={i}>
                <span className="font-medium">{person.name}</span>
                {person.role && <span className="text-slate-500"> — {person.role}</span>}
                {person.linkedin && (
                  <a
                    href={person.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 text-xs text-blue-600 underline-offset-2 hover:underline"
                  >
                    LinkedIn
                  </a>
                )}
                <SourceLink url={person.source_url} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="italic text-slate-400">{NOT_AVAILABLE}</span>
        )}
      </Section>

      <Section title="Web & Social">
        <LinkField label="Website" url={report.website} />
        <LinkField label="LinkedIn" url={report.linkedin_url} />
        <LinkField label="Facebook" url={report.social_links.facebook} />
        <LinkField label="Instagram" url={report.social_links.instagram} />
        <LinkField label="Twitter / X" url={report.social_links.twitter} />
        <LinkField label="YouTube" url={report.social_links.youtube ?? ''} />
        <LinkField label="TikTok" url={report.social_links.tiktok ?? ''} />
        <LinkField label="WhatsApp" url={report.social_links.whatsapp ?? ''} />
      </Section>

      <Section title="Website Tech Stack">
        {report.tech_stack.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {report.tech_stack.map((tech) => (
              <span key={tech} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                {tech}
              </span>
            ))}
          </div>
        ) : (
          <span className="italic text-slate-400">{NOT_AVAILABLE}</span>
        )}
      </Section>

      <Section title="Recent News">
        {report.recent_news.length > 0 ? (
          <ul className="space-y-2">
            {report.recent_news.map((item, i) => (
              <li key={i}>
                {/^https?:\/\//.test(item.url) ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 underline-offset-2 hover:underline"
                  >
                    {item.headline}
                  </a>
                ) : (
                  item.headline
                )}
                {item.date && <span className="ml-2 text-xs text-slate-400">{item.date}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <span className="italic text-slate-400">{NOT_AVAILABLE}</span>
        )}
      </Section>

      {report.not_found.length > 0 && (
        <Section title="Not Publicly Available">
          <p className="text-slate-500">{report.not_found.join(', ')}</p>
        </Section>
      )}
    </div>
  );
}
