import * as SDK from './lib/SDK.min.js';

// applyTheme makes the SDK inject the host theme as CSS variables, which
// styles.css consumes so the tab matches light/dark mode.
SDK.init({ loaded: false, applyTheme: true });

// The analysis is produced by the AIBuildAnalyzer pipeline task, which attaches
// it to the build. This tab only reads that attachment from Azure DevOps itself
// (same origin), so no external backend is needed.
const ATTACHMENT_TYPE = 'ai-build-analyzer';

const els = {};

function cacheEls() {
  [
    'loading', 'loading-detail', 'results', 'error', 'error-message', 'empty',
    'result-summary', 'result-root-cause', 'result-errors', 'result-fixes',
    'result-raw', 'result-source', 'analyze-button', 'confidence-fill'
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

function setState(state, message) {
  els.loading.classList.toggle('hidden', state !== 'loading');
  els.results.classList.toggle('hidden', state !== 'results');
  els.error.classList.toggle('hidden', state !== 'error');
  els.empty.classList.toggle('hidden', state !== 'empty');
  els['analyze-button'].disabled = state === 'loading';
  if (state === 'error') els['error-message'].textContent = message || 'Loading the analysis failed.';
}

function setLoadingDetail(text) {
  if (els['loading-detail']) els['loading-detail'].textContent = text || '';
}

function getQueryParam(url, name) {
  if (!url) return null;
  try {
    return new URL(url, window.location.origin).searchParams.get(name);
  } catch {
    return null;
  }
}

// --- Azure DevOps context resolution -------------------------------------

async function authHeaders() {
  const headers = {};
  try {
    const token = await SDK.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (e) {
    console.warn('Could not get Azure DevOps access token; falling back to cookie credentials.', e);
  }
  return headers;
}

async function azdoFetch(url, options) {
  const headers = Object.assign({}, await authHeaders(), options && options.headers);
  return fetch(url, Object.assign({ credentials: 'include' }, options || {}, { headers }));
}

function findBuildIdDeep(value, depth = 0) {
  if (!value || depth > 6) return null;
  if (typeof value === 'string') return getQueryParam(value, 'buildId');
  if (typeof value !== 'object') return null;
  for (const key of ['buildId', 'buildID', 'buildid', 'runId', 'runID']) {
    if (value[key]) return value[key];
  }
  if (value.build && (value.build.id || value.build.buildId)) return value.build.id || value.build.buildId;
  for (const key of Object.keys(value)) {
    const found = findBuildIdDeep(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function getBuildId() {
  let cfg = null;
  let pageContext = null;
  try { cfg = SDK.getConfiguration(); } catch (e) { console.warn('SDK.getConfiguration failed', e); }
  try { pageContext = SDK.getPageContext(); } catch (e) { console.warn('SDK.getPageContext failed', e); }
  const context = cfg && (cfg.context || cfg);
  const candidates = [
    context && context.buildId,
    context && context.build && context.build.id,
    context && context.build && context.build.buildId,
    getQueryParam(window.location.href, 'buildId'),
    getQueryParam(document.referrer, 'buildId'),
    findBuildIdDeep(cfg),
    findBuildIdDeep(pageContext)
  ];
  return candidates.find(Boolean);
}

function parseAzdoContextFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const buildIndex = segments.findIndex((s) => s.toLowerCase() === '_build');
    if (buildIndex <= 0) return null;
    const project = segments[buildIndex - 1];
    const collection = segments.slice(0, buildIndex - 1);
    const orgUrl = collection.length ? `${parsed.origin}/${collection.join('/')}` : parsed.origin;
    return { orgUrl, project };
  } catch {
    return null;
  }
}

function getAzdoContext() {
  try {
    const wc = SDK.getWebContext();
    if (wc && wc.project && wc.host) {
      return { orgUrl: wc.host.uri.replace(/\/$/, ''), project: wc.project.id || wc.project.name };
    }
  } catch (e) {
    console.warn('SDK.getWebContext failed; falling back to URL parsing.', e);
  }
  const ctx = parseAzdoContextFromUrl(document.referrer) || parseAzdoContextFromUrl(window.location.href);
  if (ctx) return ctx;
  throw new Error('Azure DevOps project context was not found. Refresh the build results page and reopen the AI Analyzer tab.');
}

// --- Build data ----------------------------------------------------------

async function fetchBuildDetails(ctx, buildId) {
  const resp = await azdoFetch(`${ctx.orgUrl}/${ctx.project}/_apis/build/builds/${buildId}?api-version=7.1`);
  if (!resp.ok) throw new Error(`Could not read build details (HTTP ${resp.status}).`);
  return resp.json();
}

/** Fetch the analysis attachment produced by the AIBuildAnalyzer task; null when absent. */
async function fetchAnalysisAttachment(ctx, buildId) {
  const listUrl = `${ctx.orgUrl}/${ctx.project}/_apis/build/builds/${buildId}/attachments/${ATTACHMENT_TYPE}?api-version=7.1`;
  const listResp = await azdoFetch(listUrl);
  if (!listResp.ok) {
    if (listResp.status === 404) return null;
    throw new Error(`Could not read build attachments (HTTP ${listResp.status}).`);
  }
  const list = await listResp.json();
  const items = list.value || [];
  if (items.length === 0) return null;

  // Use the most recent attachment (last attempt wins).
  const item = items[items.length - 1];
  const href = item._links && item._links.self && item._links.self.href;
  if (!href) return null;

  const contentResp = await azdoFetch(href);
  if (!contentResp.ok) throw new Error(`Could not download the analysis (HTTP ${contentResp.status}).`);
  return contentResp.json();
}

// --- Rendering -----------------------------------------------------------

function renderList(container, items) {
  container.innerHTML = '';
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (values.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None reported.';
    container.appendChild(li);
    return;
  }
  for (const item of values) {
    const li = document.createElement('li');
    li.textContent = String(item);
    container.appendChild(li);
  }
}

/** Strip leading ISO timestamps that Azure DevOps prefixes on every log line. */
function stripTimestamp(line) {
  return String(line).replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, '');
}

function renderResult(data) {
  els['result-summary'].textContent = data.summary || 'The analyzer returned no summary.';
  els['result-root-cause'].textContent = data.rootCause || 'No precise root cause was identified.';
  renderList(els['result-errors'], (data.errors || []).map(stripTimestamp));
  renderList(els['result-fixes'], data.suggestedFixes);
  els['result-raw'].textContent = data.rawInsights || JSON.stringify(data, null, 2);

  if (els['result-source']) {
    const isLlm = data.source === 'llm';
    const pct = typeof data.confidence === 'number' ? ` · ${Math.round(data.confidence * 100)}%` : '';
    els['result-source'].textContent = `${isLlm ? '🤖 LLM analysis' : '⚙️ heuristic analysis'}${pct}`;
    els['result-source'].className = `source-badge ${isLlm ? 'source-llm' : 'source-heuristic'}`;
  }
  if (els['confidence-fill']) {
    const pct = typeof data.confidence === 'number' ? Math.round(data.confidence * 100) : 0;
    els['confidence-fill'].style.width = `${pct}%`;
  }
  setState('results');
}

// --- Orchestration -------------------------------------------------------

async function loadAnalysis() {
  try {
    setState('loading');
    setLoadingDetail('Resolving build context…');

    const buildId = getBuildId();
    if (!buildId) throw new Error('Build ID was not found. Refresh the build results page and reopen the AI Analyzer tab.');

    const ctx = getAzdoContext();
    const build = await fetchBuildDetails(ctx, buildId);

    if (build.result && !['failed', 'canceled'].includes(String(build.result).toLowerCase())) {
      renderResult({
        source: 'heuristics',
        summary: `This run finished with result "${build.result}", so no failure analysis is needed.`,
        rootCause: '', errors: [], suggestedFixes: [], rawInsights: '', confidence: 1
      });
      return;
    }

    setLoadingDetail('Looking for the analysis attachment…');
    const analysis = await fetchAnalysisAttachment(ctx, buildId);
    if (!analysis) {
      setState('empty');
      return;
    }
    renderResult(analysis);
  } catch (error) {
    console.error('AI Analyzer error:', error);
    setState('error', error.message || 'Loading the analysis failed.');
  }
}

SDK.ready().then(() => {
  cacheEls();
  els['analyze-button'].addEventListener('click', loadAnalysis);
  SDK.notifyLoadSucceeded();
  loadAnalysis();
});
