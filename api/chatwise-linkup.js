// Vercel Serverless Function for ChatWise Custom Search -> Linkup adapter
import fetch from 'node-fetch';

// ========== Config via Environment Variables ==========
// 必填：Linkup API Key（在 Vercel 的项目环境变量中配置）
const LINKUP_API_KEY = process.env.LINKUP_API_KEY;

// 可选：默认搜索深度 standard | deep（deep 成本更高）
const DEFAULT_DEPTH = process.env.LINKUP_DEFAULT_DEPTH || 'standard';

// 可选：默认输出类型：searchResults（推荐）或 sourcedAnswer
// - searchResults：返回链接列表，更适配 ChatWise 需求
// - sourcedAnswer：会返回带来源的答案，需要在下面映射为链接
const DEFAULT_OUTPUT_TYPE = process.env.LINKUP_DEFAULT_OUTPUT_TYPE || 'searchResults';

// 可选：是否在返回中附加 Linkup 原始响应以便调试（生产环境建议 false）
const DEBUG_ATTACH_ORIGINAL = (process.env.DEBUG_ATTACH_ORIGINAL || 'false').toLowerCase() === 'true';

// 可选：是否允许任意来源 CORS（本地调试或特定前端直连时使用，ChatWise 调用一般不需要）
const ENABLE_CORS = (process.env.ENABLE_CORS || 'false').toLowerCase() === 'true';

// 可选：是否在响应中包含原因短语（错误细节）
const EXPOSE_ERROR_DETAIL = (process.env.EXPOSE_ERROR_DETAIL || 'false').toLowerCase() === 'true';

// 可选：全局开关 - 固定 includeDomains（JSON 数组字符串，如 '["microsoft.com","agolution.com"]'）
const STATIC_INCLUDE_DOMAINS = safeParseJSON(process.env.LINKUP_STATIC_INCLUDE_DOMAINS);

// 可选：全局开关 - 固定 excludeDomains（JSON 数组字符串，如 '["wikipedia.com"]'）
const STATIC_EXCLUDE_DOMAINS = safeParseJSON(process.env.LINKUP_STATIC_EXCLUDE_DOMAINS);

// 可选：全局时间过滤（YYYY-MM-DD），如有需要才设置
const STATIC_FROM_DATE = process.env.LINKUP_STATIC_FROM_DATE || undefined;
const STATIC_TO_DATE = process.env.LINKUP_STATIC_TO_DATE || undefined;

// 可选：是否请求图片（true/false）
const STATIC_INCLUDE_IMAGES = parseBoolean(process.env.LINKUP_STATIC_INCLUDE_IMAGES, false);

// Linkup API endpoint
const LINKUP_SEARCH_URL = 'https://api.linkup.so/v1/search';

// 通用超时时间（毫秒）
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);

// ========== Helpers ==========
function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const v = String(value).toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

function safeParseJSON(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}

function withTimeout(promise, timeoutMs, error) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(error || new Error('Request timeout')), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise
  ]);
}

function buildCORSHeaders() {
  if (!ENABLE_CORS) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function sendJSON(res, status, data) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCORSHeaders()
  };
  res.statusCode = status;
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(data));
}

function extractLinksFromSearchResults(data, maxResults) {
  // 假设 Linkup 返回 { results: [{ title, url, snippet, ... }, ...] }
  const resultsArr = Array.isArray(data?.results) ? data.results : [];
  const sliced = typeof maxResults === 'number' && maxResults > 0
    ? resultsArr.slice(0, maxResults)
    : resultsArr;

  const links = sliced.map(item => ({
    title: item?.title || item?.name || '',
    url: item?.url || '',
    content: item?.snippet || item?.summary || ''
  }));

  return links;
}

function extractLinksFromSourcedAnswer(data, maxResults) {
  // 当 outputType=sourcedAnswer 时，Linkup 可能返回 { answer, sources: [{ name, url, snippet }, ...] }
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const sliced = typeof maxResults === 'number' && maxResults > 0
    ? sources.slice(0, maxResults)
    : sources;

  const links = sliced.map(src => ({
    title: src?.name || '',
    url: src?.url || '',
    content: src?.snippet || data?.answer || ''
  }));

  return links;
}

function httpError(status, message, extra) {
  const payload = { error: message || 'Unexpected Error' };
  if (EXPOSE_ERROR_DETAIL && extra) payload.detail = extra;
  return { status, payload };
}

// ========== Main Handler ==========
export default async function handler(req, res) {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      const headers = buildCORSHeaders();
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      res.status(204).end();
      return;
    }

    if (req.method !== 'POST') {
      const { status, payload } = httpError(405, 'Method Not Allowed. Use POST.');
      return sendJSON(res, status, payload);
    }

    if (!LINKUP_API_KEY) {
      const { status, payload } = httpError(500, 'Server not configured: LINKUP_API_KEY is missing.');
      return sendJSON(res, status, payload);
    }

    let body = null;
    try {
      body = req.body && Object.keys(req.body).length ? req.body : await readJSON(req);
    } catch (e) {
      const { status, payload } = httpError(400, 'Invalid JSON body', String(e));
      return sendJSON(res, status, payload);
    }

    const queries = Array.isArray(body?.queries) ? body.queries : [];
    const maxResults = Number.isInteger(body?.max_results) ? body.max_results : undefined;
    const excludeDomainsFromClient = Array.isArray(body?.exclude_domains) ? body.exclude_domains : [];

    if (queries.length === 0) {
      const { status, payload } = httpError(400, 'Field "queries" is required and must be a non-empty array.');
      return sendJSON(res, status, payload);
    }

    // 拼装 Linkup 的公共参数
    // 来自环境变量的静态 include/exclude domains 与时间范围
    // ChatWise 自定义搜索目前只传 exclude_domains，因此 includeDomains 可由你静态配置
    const linkupCommon = {
      depth: DEFAULT_DEPTH,
      outputType: DEFAULT_OUTPUT_TYPE,
      includeImages: STATIC_INCLUDE_IMAGES
    };

    if (Array.isArray(STATIC_INCLUDE_DOMAINS) && STATIC_INCLUDE_DOMAINS.length > 0) {
      linkupCommon.includeDomains = STATIC_INCLUDE_DOMAINS;
    }
    // 将 ChatWise 传来的 exclude_domains 与静态排除域合并（去重）
    const mergedExclude = [
      ...excludeDomainsFromClient,
      ...(Array.isArray(STATIC_EXCLUDE_DOMAINS) ? STATIC_EXCLUDE_DOMAINS : [])
    ].filter(Boolean);
    if (mergedExclude.length > 0) {
      linkupCommon.excludeDomains = Array.from(new Set(mergedExclude));
    }

    if (STATIC_FROM_DATE) linkupCommon.fromDate = STATIC_FROM_DATE;
    if (STATIC_TO_DATE) linkupCommon.toDate = STATIC_TO_DATE;

    // 并行请求每个 query
    const tasks = queries.map(async (q) => {
      const payload = { q, ...linkupCommon };

      const resp = await withTimeout(fetch(LINKUP_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LINKUP_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }), REQUEST_TIMEOUT_MS, new Error('Linkup request timeout'));

      // Linkup 错误处理
      if (!resp.ok) {
        const text = await resp.text();
        // 常见情况：429 余额不足
        const extra = `Upstream status=${resp.status}, body=${text}`;
        throw new Error(extra);
      }

      const data = await resp.json();

      // 根据 outputType 选择提取方式
      let links;
      if ((linkupCommon.outputType || '').toLowerCase() === 'sourcedanswer') {
        links = extractLinksFromSourcedAnswer(data, maxResults);
      } else {
        links = extractLinksFromSearchResults(data, maxResults);
      }

      const resultItem = { query: q, links };

      if (DEBUG_ATTACH_ORIGINAL) {
        resultItem._debug_original = data;
      }

      return resultItem;
    });

    let results = [];
    try {
      results = await Promise.all(tasks);
    } catch (e) {
      // 如果其中一个 query 出错，你可以选择：要么整体报错；要么部分容错返回成功的条目。
      // 这里选“整体报错”，便于你在 ChatWise 中快速发现与修复。
      const { status, payload } = httpError(502, 'Upstream Linkup API error', String(e));
      return sendJSON(res, status, payload);
    }

    return sendJSON(res, 200, { results });
  } catch (err) {
    const { status, payload } = httpError(500, 'Internal server error', String(err?.message || err));
    return sendJSON(res, status, payload);
  }
}

// 读取原始 JSON 的小工具（当 req.body 未被自动解析时使用）
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try {
        const json = raw ? JSON.parse(raw) : {};
        resolve(json);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
