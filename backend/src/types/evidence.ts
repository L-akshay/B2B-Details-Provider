import type { HarvestedContacts } from '../services/emailDiscovery';
import type { ScrapedSite } from '../services/firecrawl';
import type { GleifRecord } from '../services/gleif';
import type { SearchHit } from '../services/googleSearch';
import type { CompoundResearch } from '../services/groqCompound';
import type { DnsIntel } from '../services/dnsIntel';
import type { SocialProfiles } from '../services/socialLinks';
import type { DomainRegistration } from '../services/whois';
import type { WikidataFacts } from '../services/wikidata';
import type { NewsItem, ServiceResult } from './schema';

/** Everything the collection stage gathered, fed to both extraction passes. */
export interface EvidenceBundle {
  companyName: string;
  extraInfo?: string;
  domain: string | null;
  compound: ServiceResult<CompoundResearch>;
  site: ServiceResult<ScrapedSite>;
  wikidata: ServiceResult<WikidataFacts>;
  gleif: ServiceResult<GleifRecord[]>;
  news: ServiceResult<NewsItem[]>;
  registration: ServiceResult<DomainRegistration>;
  dns: ServiceResult<DnsIntel>;
  tech: ServiceResult<string[]>;
  cse: ServiceResult<SearchHit[]>;
  contacts: HarvestedContacts;
  /** Deterministically harvested from the site's link graph + raw HTML */
  socialHarvest: SocialProfiles;
  /** Search-grounded official-profile lookup */
  socialSearch: ServiceResult<SocialProfiles>;
}
