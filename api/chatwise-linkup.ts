export const config = { runtime: 'edge' };

// 读取环境变量的安全函数（Edge 下通常可用 process.env）
function env(name: string, fallback?: string) {
  try {
    const v = (process as any)?.env?.[name];
    if (v === undefined || v === null || v === '') return fallback;
    return String(v);
  } catch {
    // 某些 Edge 环境不允许直接访问 process，这里兜底
    // 你也可以考虑使用 Vercel 的加密环境变量，或者在构建时注入
    return fallback;
  }
}

// 基础配置
const LINKUP_API_KEY = env('LINKUP_API_KEY');
const DEFAULT_DEPTH = env('LINKUP_DEFAULT_DEPTH', 'standard'); // standard | deep
const DEFAULT_OUTPUT_TYPE = env('LINKUP_DEFAULT_OUTPUT_TYPE', 'searchResults'); // searchResults | sourcedAnswer
const DEBUG_ATTACH_ORIGINAL = toBool(env('DEBUG_ATTACH_ORIGINAL', 'false'));
const ENABLE_CORS = toBool(env('ENABLE_CORS', 'false'));
const EXPOSE_ERROR_DETAIL = toBool(env('EXPOSE_ERROR_DETAIL', 'false'));

const STATIC_INCLUDE_DOMAINS = safeParseJSON(env('LINKUP_STATIC_INCLUDE_DOMAINS'));
const STATIC_EXCLUDE_DOMAINS = safeParseJSON(env('LINKUP_STATIC_EXCLUDE_DOMAINS'));
const STATIC_FROM_DATE = env('LINKUP_STATIC_FROM_DATE');
const STATIC_TO_DATE = env('LINKUP_STATIC_TO_DATE');
const STATIC_INCLUDE_IMAGES = toBool(env('LINKUP_STATIC_INCLUDE_IMAGES', 'false'));

const LINKUP_SEARCH_URL = 'https://api.linkup.so/v1/search';
const REQUEST_TIMEOUT_MS = toInt(env('REQUEST_TIMEOUT_MS', '60000'), 60000);

// 工具函数
function toBool(v?: string) {
  if (!v) return false;
  const s = v.toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

function toInt(v?: string, def = 0) {
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function safeParseJSON(value?: string) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function corsHeaders() {
  if (!ENABLE_CORS) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  } as Record<string, string>;
}

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}

function httpError(status: number, message: string, extra?: string) {
  const payload: Record<string, unknown> = { error: message };
  if (EXPOSE_ERROR_DETAIL && extra) payload.detail = extra;
  return json(status, payload);
}

function extractLinksFromSearchResults(data: any, maxResults?: number) {
  const resultsArr = Array.isArray(data && data.results) ? data.results : [];
  const sliced = typeof maxResults === 'number' && maxResults > 0 ? resultsArr.slice(0, maxResults) : resultsArr;
  return sliced.map((item: any) => ({
    title: (item && (item.title || item.name)) || '',
    url: (item && item.url) || '',
    content: (item && (item.snippet || item.summary)) || ''
  }));
}

function extractLinksFromSourcedAnswer(data: any, maxResults?: number) {
  const sources = Array.isArray(data && data.sources) ? data.sources : [];
  const sliced = typeof maxResults === 'number' && maxResults > 0 ? sources.slice(0, maxResults) : sources;
  return sliced.map((src: any) => ({
    title: (src && src.name) || '',
    url: (src && src.url) || '',
    content: (src && src.snippet) || (data && data.answer) || ''
  }));
}

// 带超时的 fetch（Edge：AbortController）
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req: Request) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method !== 'POST') {
      return httpError(405, 'Method Not Allowed. Use POST.');
    }
    if (!LINKUP_API_KEY) {
      return httpError(500, 'Server not configured: LINKUP_API_KEY is missing.');
    }

    let body: any;
    try {
      body = await req.json();
    } catch (e: any) {
      return httpError(400, 'Invalid JSON body', String(e && e.message ? e.message : e));
    }

    const queries = Array.isArray(body && body.queries) ? body.queries : [];
    const maxResults = Number.isInteger(body && body.max_results) ? body.max_results : undefined;
    const excludeDomainsFromClient = Array.isArray(body && body.exclude_domains) ? body.exclude_domains : [];

    if (!queries || queries.length === 0) {
      return httpError(400, 'Field "queries" is required and must be a non-empty array.');
    }

    const linkupCommon: Record<string, unknown> = {
      depth: DEFAULT_DEPTH,
      outputType: DEFAULT_OUTPUT_TYPE,
      includeImages: STATIC_INCLUDE_IMAGES
    };

    if (Array.isArray(STATIC_INCLUDE_DOMAINS) && STATIC_INCLUDE_DOMAINS.length > 0) {
      linkupCommon.includeDomains = STATIC_INCLUDE_DOMAINS;
    }

    const mergedExclude = [
      ...excludeDomainsFromClient,
      ...(Array.isArray(STATIC_EXCLUDE_DOMAINS) ? STATIC_EXCLUDE_DOMAINS : [])
    ].filter(Boolean);
    if (mergedExclude.length > 0) {
      linkupCommon.excludeDomains = Array.from(new Set(mergedExclude));
    }

    if (STATIC_FROM_DATE) linkupCommon.fromDate = STATIC_FROM_DATE;
    if (STATIC_TO_DATE) linkupCommon.toDate = STATIC_TO_DATE;

    // 并行执行所有查询
    const tasks = queries.map(async (q: string) => {
      const payload = { q, ...linkupCommon };

      const resp = await fetchWithTimeout(
        LINKUP_SEARCH_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${LINKUP_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        },
        REQUEST_TIMEOUT_MS
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Upstream status=${resp.status}, body=${text}`);
      }

      const data = await resp.json();

      let links;
      const ot = String(linkupCommon.outputType || '').toLowerCase();
      if (ot === 'sourcedanswer') {
        links = extractLinksFromSourcedAnswer(data, maxResults);
      } else {
        links = extractLinksFromSearchResults(data, maxResults);
      }

      const item: Record<string, unknown> = { query: q, links };
      if (DEBUG_ATTACH_ORIGINAL) {
        item._debug_original = data;
      }
      return item;
    });

    let results: any[];
    try {
      results = await Promise.all(tasks);
    } catch (e: any) {
      return httpError(502, 'Upstream Linkup API error', String(e && e.message ? e.message : e));
    }

    return json(200, { results });
  } catch (err: any) {
    return httpError(500, 'Internal server error', String(err && err.message ? err.message : err));
  }
}
