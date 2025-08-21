export const config = { runtime: 'edge' };

// 环境变量读取：在 Edge Runtime 下请使用 process.env 不可用，需用 import.meta.env（Vercel 会注入），
// 但推荐用 Vercel 的 Edge Runtime 方式：通过 process.env 仍可在 Edge 上注入。若报 undefined，改用直传。
// 兼容写法如下：
function env(name: string, fallback?: string) {
  const v = (process as any)?.env?.[name] ?? (globalThis as any)?.[name] ?? fallback;
  return v;
}

const LINKUP_API_KEY = env('LINKUP_API_KEY');
const DEFAULT_DEPTH = env('LINKUP_DEFAULT_DEPTH', 'standard'); // standard | deep
const DEFAULT_OUTPUT_TYPE = env('LINKUP_DEFAULT_OUTPUT_TYPE', 'searchResults'); // searchResults | sourcedAnswer
const DEBUG_ATTACH_ORIGINAL = (env('DEBUG_ATTACH_ORIGINAL', 'false') as string).toLowerCase() === 'true';
const ENABLE_CORS = (env('ENABLE_CORS', 'false') as string).toLowerCase() === 'true';
const EXPOSE_ERROR_DETAIL = (env('EXPOSE_ERROR_DETAIL', 'false') as string).toLowerCase() === 'true';

const STATIC_INCLUDE_DOMAINS = safeParseJSON(env('LINKUP_STATIC_INCLUDE_DOMAINS'));
const STATIC_EXCLUDE_DOMAINS = safeParseJSON(env('LINKUP_STATIC_EXCLUDE_DOMAINS'));
const STATIC_FROM_DATE = env('LINKUP_STATIC_FROM_DATE');
const STATIC_TO_DATE = env('LINKUP_STATIC_TO_DATE');
const STATIC_INCLUDE_IMAGES = parseBoolean(env('LINKUP_STATIC_INCLUDE_IMAGES'), false);

const LINKUP_SEARCH_URL = 'https://api.linkup.so/v1/search';
const REQUEST_TIMEOUT_MS = parseInt(env('REQUEST_TIMEOUT_MS', '60000')!, 10);

function parseBoolean(value: any, def = false) {
  if (value === undefined) return def;
  const v = String(value).toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

function safeParseJSON(value: any) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function buildCORSHeaders() {
  if (!ENABLE_CORS) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(status: number, data: any) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...buildCORSHeaders(),
    },
  });
}

function httpError(status: number, message: string, extra?: string) {
  const payload: any = { error: message };
  if (EXPOSE_ERROR_DETAIL && extra) payload.detail = extra;
  return jsonResponse(status, payload);
}

function extractLinksFromSearchResults(data: any, maxResults?: number) {
  const resultsArr = Array.isArray(data?.results) ? data.results : [];
  const sliced =
    typeof maxResults === 'number' && maxResults > 0
      ? resultsArr.slice(0, maxResults)
      : resultsArr;

  const links = sliced.map((item: any) => ({
    title: item?.title || item?.name || '',
    url: item?.url || '',
    content: item?.snippet || item?.summary || '',
  }));
  return links;
}

function extractLinksFromSourcedAnswer(data: any, maxResults?: number) {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const sliced =
    typeof maxResults === 'number' && maxResults > 0
      ? sources.slice(0, maxResults)
      : sources;

  const links = sliced.map((src: any) => ({
    title: src?.name || '',
    url: src?.url || '',
    content: src?.snippet || data?.answer || '',
  }));
  return links;
}

// Edge 中实现超时：利用 Promise.race + AbortController
async function fetchWithTimeout(resource: string, options: RequestInit & { timeout?: number } = {}) {
  const { timeout, ...init } = options;
  if (!timeout) return fetch(resource, init);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort('timeout'), timeout);
  try {
    return await fetch(resource, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req: Request) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCORSHeaders(),
      });
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
      return httpError(400, 'Invalid JSON body', String(e?.message || e));
    }

    const queries: string[] = Array.isArray(body?.queries) ? body.queries : [];
    const maxResults = Number.isInteger(body?.max_results) ? body.max_results : undefined;
    const excludeDomainsFromClient: string[] = Array.isArray(body?.exclude_domains) ? body.exclude_domains : [];

    if (queries.length === 0) {
      return httpError(400, 'Field "queries" is required and must be a non-empty array.');
    }

    const linkupCommon: any = {
      depth: DEFAULT_DEPTH,
      outputType: DEFAULT_OUTPUT_TYPE,
      includeImages: STATIC_INCLUDE_IMAGES,
    };

    if (Array.isArray(STATIC_INCLUDE_DOMAINS) && STATIC_INCLUDE_DOMAINS.length > 0) {
      linkupCommon.includeDomains = STATIC_INCLUDE_DOMAINS;
    }

    const mergedExclude = [
      ...excludeDomainsFromClient,
      ...(Array.isArray(STATIC_EXCLUDE_DOMAINS) ? STATIC_EXCLUDE_DOMAINS : []),
    ].filter(Boolean);
    if (mergedExclude.length > 0) {
      linkupCommon.excludeDomains = Array.from(new Set(mergedExclude));
    }

    if (STATIC_FROM_DATE) linkupCommon.fromDate = STATIC_FROM_DATE;
    if (STATIC_TO_DATE) linkupCommon.toDate = STATIC_TO_DATE;

    // 并行处理每个 query
    const tasks = queries.map(async (q) => {
      const payload = { q, ...linkupCommon };

      const resp = await fetchWithTimeout(LINKUP_SEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${LINKUP_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Upstream status=${resp.status}, body=${text}`);
      }

      const data = await resp.json();

      let links;
      if ((linkupCommon.outputType || '').toLowerCase() === 'sourcedanswer') {
        links = extractLinksFromSourcedAnswer(data, maxResults);
      } else {
        links = extractLinksFromSearchResults(data, maxResults);
      }

      const resultItem: any = { query: q, links };
      if (DEBUG_ATTACH_ORIGINAL) resultItem._debug_original = data;
      return resultItem;
    });

    let results;
    try {
      results = await Promise.all(tasks);
    } catch (e: any) {
      return httpError(502, 'Upstream Linkup API error', String(e?.message || e));
    }

    return jsonResponse(200, { results });
  } catch (err: any) {
    return httpError(500, 'Internal server error', String(err?.message || err));
  }
}
