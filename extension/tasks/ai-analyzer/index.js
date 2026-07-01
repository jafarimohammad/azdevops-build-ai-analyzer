'use strict';
// AI Build Analyzer pipeline task.
// Runs on the build agent after a failure: reads the failed-task logs through the
// Azure DevOps REST API, asks an OpenAI-compatible LLM for a diagnosis (falling
// back to offline heuristics), and attaches the result JSON to the build so the
// AI Analyzer tab can display it. Self-contained: no npm dependencies, and it
// never fails the build.
// NOTE: keep this file Node 10 compatible (no ?. / ?? / optional catch binding).

var https = require('https');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var URL = require('url').URL;

var ATTACHMENT_TYPE = 'ai-build-analyzer';

// ---------------------------------------------------------------- helpers ---

function getInput(name, def) {
  var v = process.env['INPUT_' + name.toUpperCase()];
  if (v === undefined || v === null || v === '') return def;
  return v;
}

function getAccessToken() {
  try {
    var ep = process.env.ENDPOINT_AUTH_SYSTEMVSSCONNECTION;
    if (ep) {
      var parsed = JSON.parse(ep);
      if (parsed.parameters && parsed.parameters.AccessToken) return parsed.parameters.AccessToken;
    }
  } catch (e) { /* fall through */ }
  return process.env.SYSTEM_ACCESSTOKEN || '';
}

function request(urlStr, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL: ' + urlStr)); }
    var lib = u.protocol === 'https:' ? https : http;
    var reqOpts = {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout || 60000
    };
    if (u.protocol === 'https:') reqOpts.rejectUnauthorized = !opts.insecure;
    var req = lib.request(u, reqOpts, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('Request timed out: ' + urlStr)); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ------------------------------------------------------------ log analysis ---

var ERROR_LINE = /\berror\b|\bfailed\b|\bfailure\b|exception|traceback|stack trace|segfault|panic|##\[error\]|npm ERR!|MSB\d{3,}|CS\d{3,}|exited with code [1-9]/i;

function sanitize(input, maxLen) {
  if (!input) return '';
  var cleaned = input
    .replace(/\r\n/g, '\n')
    // strip the ISO timestamp Azure DevOps prefixes on every log line
    // (saves LLM tokens and keeps the reported error lines readable)
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?/gm, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // redact secrets so they never reach the LLM or the attachment
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*)("?)[^\s"'&]+/gi, '$1$2***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***');
  if (cleaned.length <= maxLen) return cleaned;
  var half = Math.floor(maxLen / 2);
  return cleaned.slice(0, half) + '\n\n...[truncated]...\n\n' + cleaned.slice(-half);
}

// Drop framework/stack-trace noise (Go runtime frames, grpc/buildkit internals,
// buildx command echoes) so the real error lines aren't buried. Keeps the
// ##[error]/##[warning] prefix into account when matching.
var NOISE_LINE = /^(at\s|github\.com\/|google\.golang\.org\/|go\.opentelemetry\.io\/|golang\.org\/x\/|\/go\/src\/|\/usr\/local\/go\/|runtime\.goexit|\d+\s+\/usr\/local\/bin\/dockerd|\d+ v\d+\.\d|docker-buildx buildx build)/;

function denoise(text) {
  if (!text) return '';
  return text.split('\n').filter(function (l) {
    var s = l.replace(/^##\[(error|warning|debug|section)\]/, '').replace(/^\s+/, '');
    return s.length === 0 ? true : !NOISE_LINE.test(s);
  }).join('\n');
}

// Redact + drop noise, then prefix each surviving line with its ORIGINAL 1-based
// line number in that task's log, so the line numbers match what the Azure DevOps
// log viewer shows. Lets both the heuristics and the LLM cite "where" an error is.
function cleanAndNumber(rawText) {
  var clean = sanitize(rawText, 1e12); // redact + strip timestamps, no truncation (line count preserved)
  var lines = clean.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].replace(/^##\[(error|warning|debug|section)\]/, '').replace(/^\s+/, '');
    if (s.length && NOISE_LINE.test(s)) continue;
    out.push((i + 1) + '| ' + lines[i]);
  }
  return out.join('\n');
}

function extractImportant(logs, contextLines) {
  if (!logs) return '';
  contextLines = contextLines || 6;
  var lines = logs.split('\n');
  var blocks = [];
  for (var i = 0; i < lines.length; i++) {
    if (!ERROR_LINE.test(lines[i])) continue;
    var start = Math.max(0, i - contextLines);
    var end = Math.min(lines.length, i + contextLines + 1);
    blocks.push(lines.slice(start, end).join('\n'));
    i = end - 1;
  }
  var seen = {};
  var unique = blocks.filter(function (b) {
    if (seen[b]) return false;
    seen[b] = true;
    return true;
  });
  return unique.join('\n---\n');
}

function topErrorLines(logs, limit) {
  limit = limit || 8;
  if (!logs) return [];
  var seen = {};
  var out = [];
  var lines = logs.split('\n');
  for (var i = 0; i < lines.length && out.length < limit; i++) {
    var line = lines[i].trim();
    if (line.length < 5 || !ERROR_LINE.test(line) || seen[line]) continue;
    seen[line] = true;
    out.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
  }
  return out;
}

var RULES = [
  { test: /npm ERR!\s+code\s+ERESOLVE|unable to resolve dependency tree/i,
    rootCause: 'npm could not resolve the dependency tree (conflicting peer dependencies).',
    fix: 'Align the conflicting package versions, or run `npm install --legacy-peer-deps` / fix the offending peer dependency in package.json.' },
  { test: /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
    rootCause: 'A module is missing at build time.',
    fix: 'Verify the dependency is in package.json, the lockfile is committed, and `npm ci`/restore runs before the build step.' },
  { test: /(pull access denied|manifest unknown|manifest for .+ not found|not found: manifest|repository .+ not found|denied: requested access)/i,
    rootCause: 'A Docker image could not be pulled — the image name/tag is wrong, missing from the registry, or requires authentication.',
    fix: 'Check the FROM lines in the Dockerfile: verify the registry host, image name and tag exist and are reachable, and that the agent is logged in to that registry.' },
  { test: /failed to solve|failed to compute cache key|no match for platform|error: failed to (fetch|export)/i,
    rootCause: 'The Docker image build failed (buildkit could not resolve a stage, base image, or build context).',
    fix: 'Read the "failed to solve" line: confirm each FROM base image exists in its registry, the referenced COPY/ADD paths exist, and the platform matches. A "<image>: not found" usually means a wrong registry/name/tag.' },
  { test: /error\s+(TS\d+|CS\d+)\b/i,
    rootCause: 'A compiler error (TypeScript/C#) stopped the build.',
    fix: 'Open the reported file:line, fix the type/compile error, and reproduce locally with the same SDK version used in the pipeline.' },
  { test: /MSB\d{3,}|MSBUILD : error/i,
    rootCause: 'An MSBuild error stopped the build.',
    fix: 'Inspect the MSBxxxx error code, restore NuGet packages, and confirm the build configuration/target framework matches the agent.' },
  { test: /error parsing|did not find expected|while parsing a block/i,
    rootCause: 'The pipeline or a config file has a YAML syntax error.',
    fix: 'Validate the pipeline YAML (indentation, mapping/colon usage) before re-running.' },
  { test: /\b\d+ (failing|failed)\b|Tests run:.*Failures:|FAILED tests/i,
    rootCause: 'One or more tests failed.',
    fix: 'Open the failing test name above, reproduce locally, and fix the assertion or the regression that broke it.' },
  { test: /\b(unauthorized|forbidden|authentication failed|invalid credentials)\b|HTTP (401|403)|status code 401|status code 403/i,
    rootCause: 'An authentication/authorization failure (registry, feed, or service connection).',
    fix: 'Check the service connection, PAT, or feed credentials and confirm they have not expired and have the required scopes.' },
  { test: /\btimed out\b|ETIMEDOUT|ESOCKETTIMEDOUT|context deadline exceeded|operation timed out|request timed out/i,
    rootCause: 'A step timed out (network or long-running command).',
    fix: 'Increase the step timeout, add retries for flaky network calls, or check that the dependency/endpoint is reachable from the agent.' },
  { test: /Bash exited with code|PowerShell exited with code|script failed with exit code|failed with exit code|##\[error\]/i,
    rootCause: 'A pipeline task exited with a non-zero code.',
    fix: 'Read the first error printed above the failed task and validate the command arguments and environment variables that step uses.' }
];

function runHeuristics(important) {
  var errors = topErrorLines(important);
  if (!important || important.trim().length < 10) {
    return {
      success: false, source: 'heuristics',
      summary: 'No analyzable log content was available.',
      rootCause: '', errors: [],
      suggestedFixes: ['Check that the failed steps produced logs.'],
      rawInsights: '', confidence: 0
    };
  }
  var fixes = [];
  var rootCause = '';
  for (var i = 0; i < RULES.length; i++) {
    if (!RULES[i].test.test(important)) continue;
    if (!rootCause) rootCause = RULES[i].rootCause;
    fixes.push(RULES[i].fix);
  }
  if (!rootCause) {
    return {
      success: false, source: 'heuristics',
      summary: 'Found error lines but no known failure pattern matched.',
      rootCause: '', errors: errors,
      suggestedFixes: ['Review the error lines below.'],
      rawInsights: '', confidence: errors.length ? 0.3 : 0.1
    };
  }
  return {
    success: true, source: 'heuristics',
    summary: rootCause, rootCause: rootCause,
    errors: errors, suggestedFixes: fixes,
    rawInsights: '', confidence: 0.5
  };
}

// -------------------------------------------------------------------- LLM ---

function chatCompletionsUrl(base) {
  base = base.replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
}

function extractJson(text) {
  var trimmed = (text || '').trim();
  var fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  var first = trimmed.indexOf('{');
  var last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function toArray(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return v ? [String(v)] : [];
}

// --- targeted source-file context (opt-in) -------------------------------

var SOURCE_MANIFESTS = ['Dockerfile', 'package.json', 'package-lock.json', 'azure-pipelines.yml', 'azure-pipelines.yaml', 'tsconfig.json', 'requirements.txt', 'pyproject.toml', 'pom.xml', 'build.gradle', 'go.mod'];
var SOURCE_EXCLUDE = /(^|[\/\\])\.env|\.(pem|key|pfx|p12|crt|cer)$|secret|credential|id_rsa/i;
var FILE_REF = /[\w.\/\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|cs|csproj|sln|py|go|java|kt|rb|php|yml|yaml|xml|toml|gradle|sh|ps1)|[\w.\/\\-]*Dockerfile(?:\.[\w-]+)?/g;

function resolveInRoot(rootAbs, rel) {
  var abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(rootAbs, rel);
  if (abs.indexOf(rootAbs) !== 0) {
    abs = path.resolve(rootAbs, path.basename(rel));
    if (abs.indexOf(rootAbs) !== 0) return null;
  }
  return abs;
}

// Reduce a huge lockfile to only the entries that could cause a version error.
function grepSuspiciousVersions(content) {
  var lines = content.split('\n');
  var out = [];
  for (var i = 0; i < lines.length && out.length < 40; i++) {
    if (/"version"\s*:\s*""/.test(lines[i]) ||
        /"version"\s*:\s*"[^"]*(?:git|file:|link:|workspace:|https?:|\/\/)/.test(lines[i])) {
      out.push((i + 1) + '| ' + lines[i].trim());
    }
  }
  return out.join('\n');
}

// Read a small, targeted set of repo files (referenced in the log + common
// manifests) from the checked-out sources on the agent, so the LLM can pinpoint
// the fix. Secrets are redacted; huge lockfiles are reduced to suspect lines.
function collectSourceContext(logText, maxBytes) {
  var root = process.env.BUILD_SOURCESDIRECTORY || process.env.BUILD_REPOSITORY_LOCALPATH;
  if (!root) return '';
  var rootAbs;
  try { if (!fs.statSync(root).isDirectory()) return ''; rootAbs = path.resolve(root); }
  catch (e) { return ''; }

  var rels = {};
  var re = new RegExp(FILE_REF.source, 'g');
  var m;
  while ((m = re.exec(logText)) !== null) rels[m[0]] = true;
  SOURCE_MANIFESTS.forEach(function (f) { rels[f] = true; });

  var out = '';
  var used = 0;
  var count = 0;
  var seenAbs = {};
  var candidates = Object.keys(rels);
  for (var i = 0; i < candidates.length && count < 8 && used < maxBytes; i++) {
    var rel = candidates[i];
    if (SOURCE_EXCLUDE.test(rel)) continue;
    var abs = resolveInRoot(rootAbs, rel);
    if (!abs || seenAbs[abs]) continue;
    seenAbs[abs] = true;
    var st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (!st.isFile() || st.size === 0 || st.size > 3000000) continue;
    var content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
    content = sanitize(content, 1000000); // redact secrets
    if (/(package-lock\.json|yarn\.lock)$/i.test(rel) && content.length > 4000) {
      content = grepSuspiciousVersions(content);
      if (!content) continue;
    } else if (content.length > 3000) {
      content = content.slice(0, 3000) + '\n...[truncated]...';
    }
    var display = path.relative(rootAbs, abs).replace(/\\/g, '/');
    var block = '===== ' + display + ' =====\n' + content + '\n\n';
    if (used + block.length > maxBytes) block = block.slice(0, maxBytes - used);
    out += block;
    used += block.length;
    count++;
  }
  return out;
}

function analyzeWithLlm(important, meta, cfg, hint, sourceCtx) {
  var userPrompt = [
    'Analyze this Azure DevOps build failure and respond with JSON only.',
    'JSON schema: {"summary": string, "rootCause": string, "errors": string[], "suggestedFixes": string[], "confidence": number}',
    '- summary: one or two sentences a developer can act on.',
    '- rootCause: the single most likely cause.',
    '- errors: the key error lines, quoted verbatim from the log INCLUDING their leading "<number>| " line-number prefix, so the developer can locate them.',
    '- suggestedFixes: concrete steps, most likely fix first.',
    '- confidence: 0..1.',
    '',
    'Rules:',
    '- Each log line is prefixed with its line number as "<n>| " and grouped under a "===== <step name> =====" header. Keep those line numbers when you quote error lines.',
    '- Base your answer ONLY on the actual error text. Identify the FIRST real error; later lines are often just its fallout.',
    '- IGNORE noise: stack traces, Go/grpc/buildkit internal frames, file paths, and any credentials, tokens or build-args in command lines. They are not the cause.',
    '- Be precise about the failure type. For Docker, distinguish a build-time base-image problem (a FROM image that is "not found" / cannot be pulled — usually a wrong registry/name/tag) from a push or login/authentication failure. Do not assume authentication unless the log actually shows an auth/denied/401/403 error.',
    sourceCtx ? '- Repository source files are included below. Use them to pinpoint the EXACT fix (e.g. name the offending dependency and version in package.json, or the wrong line in the Dockerfile), not just a generic suggestion.' : '',
    '- If unsure, say so and lower the confidence.',
    '',
    'Build: ' + (meta.definition || 'unknown') + ' #' + (meta.buildNumber || '?') + ' on ' + (meta.sourceBranch || 'unknown branch') + '.',
    meta.failedTasks && meta.failedTasks.length ? 'Failed tasks: ' + meta.failedTasks.join(', ') + '.' : '',
    hint ? 'A rule-based pre-check suggests the likely cause is: "' + hint + '". Treat it as a hint, but verify it against the log and override it if the log clearly shows otherwise.' : '',
    '',
    'Relevant log sections:',
    '"""',
    important || '(no error sections were extracted)',
    '"""',
    sourceCtx ? '\nRelevant source files from the repository:' : '',
    sourceCtx ? '"""' : '',
    sourceCtx || '',
    sourceCtx ? '"""' : ''
  ].filter(Boolean).join('\n');

  var headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

  return request(chatCompletionsUrl(cfg.url), {
    method: 'POST',
    headers: headers,
    insecure: cfg.insecure,
    timeout: cfg.timeout,
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: 'You are a senior CI/CD engineer who diagnoses Azure DevOps pipeline failures. You reply with a single JSON object and nothing else.' },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 1500
    })
  }).then(function (resp) {
    if (resp.status < 200 || resp.status >= 300) throw new Error('LLM returned HTTP ' + resp.status + ': ' + resp.body.slice(0, 300));
    var data = JSON.parse(resp.body);
    var choice = data.choices && data.choices[0];
    var text = (choice && choice.message && choice.message.content) || (choice && choice.text) || '';
    var parsed = JSON.parse(extractJson(text));
    var confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7;
    return {
      success: true, source: 'llm',
      summary: String(parsed.summary || '').trim(),
      rootCause: String(parsed.rootCause || parsed.root_cause || parsed.cause || '').trim(),
      errors: toArray(parsed.errors),
      suggestedFixes: toArray(parsed.suggestedFixes || parsed.suggested_fixes || parsed.fixes || parsed.fix),
      rawInsights: String(parsed.rawInsights || parsed.details || '').trim(),
      confidence: confidence
    };
  });
}

// ------------------------------------------------------------- AzDO access ---

function azdo(urlStr, token, insecure) {
  return request(urlStr, { headers: { Authorization: 'Bearer ' + token }, insecure: insecure, timeout: 30000 });
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function fetchFailureLogs(baseUrl, token, insecure, maxLogs, apiVersion) {
  var failedTasks = [];
  var failed = []; // { logId, name }
  var usedFallback = false;
  var v = '?api-version=' + apiVersion;

  // The analyzer runs right after the step failed, so the timeline may not have
  // flushed the failed record yet. Retry a few times before falling back.
  function tryTimeline(attemptsLeft) {
    return azdo(baseUrl + '/timeline' + v, token, insecure).then(function (resp) {
      if (resp.status === 200) {
        failed = [];
        failedTasks = [];
        var records = (JSON.parse(resp.body).records) || [];
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (String(r.result).toLowerCase() !== 'failed') continue;
          // Only the actual failed steps (Tasks). Job/Phase/Stage records carry an
          // aggregate log of the whole job, which dilutes the signal and pulls in
          // unrelated steps' output.
          if (r.type !== 'Task') continue;
          if (r.name) failedTasks.push(r.name);
          if (r.log && r.log.id !== undefined && r.log.id !== null) {
            failed.push({ logId: r.log.id, name: r.name || ('log ' + r.log.id) });
          }
        }
      } else {
        console.log('##[warning]Could not read build timeline (HTTP ' + resp.status + '): ' + String(resp.body).slice(0, 200));
      }
      if (failed.length === 0 && attemptsLeft > 0) {
        console.log('Timeline has no failed task with a log yet; retrying in 3s...');
        return delay(3000).then(function () { return tryTimeline(attemptsLeft - 1); });
      }
      return null;
    });
  }

  return tryTimeline(2)
    .then(function () {
      if (failed.length > 0) return null;
      return azdo(baseUrl + '/logs' + v, token, insecure).then(function (listResp) {
        if (listResp.status !== 200) {
          throw new Error('Could not list build logs (HTTP ' + listResp.status + ' at api-version ' + apiVersion + '): ' + String(listResp.body).slice(0, 200));
        }
        var value = JSON.parse(listResp.body).value || [];
        // No failed task from the timeline -> fall back to the whole log list.
        // Failures are almost always in late steps, and the list also contains
        // job/phase logs, so take the MOST RECENT logs first (highest id) rather
        // than the first N — otherwise the failing late step gets cut off.
        failed = value
          .map(function (l) { return { logId: l.id, name: 'log ' + l.id }; })
          .sort(function (a, b) { return b.logId - a.logId; });
        usedFallback = true;
        return null;
      });
    })
    .then(function () {
      var seen = {};
      var unique = failed.filter(function (f) { return seen[f.logId] ? false : (seen[f.logId] = true); }).slice(0, maxLogs);
      var combined = '';
      var fetched = 0;
      var chain = Promise.resolve();
      unique.forEach(function (f) {
        chain = chain.then(function () {
          return azdo(baseUrl + '/logs/' + f.logId + v, token, insecure).then(function (r) {
            // Numbered so the line numbers match the Azure DevOps log viewer for this step.
            if (r.status === 200) { combined += '\n\n===== ' + f.name + ' (log ' + f.logId + ') =====\n' + cleanAndNumber(r.body); fetched++; }
            else console.log('##[warning]Log ' + f.logId + ' returned HTTP ' + r.status + '.');
          }).catch(function (e) {
            console.log('##[warning]Log ' + f.logId + ' fetch failed: ' + e.message);
          });
        });
      });
      return chain.then(function () {
        console.log('Fetched ' + fetched + '/' + unique.length + ' log(s)' + (usedFallback ? ' (full list)' : ' (failed tasks)') + ', ' + combined.length + ' chars.');
        return { rawLogs: combined, failedTasks: failedTasks };
      });
    });
}

// -------------------------------------------------------------------- main ---

// Combine the LLM result with the deterministic heuristic baseline.
function mergeResult(result, heur) {
  if (!result) return heur;
  // Quoted error lines come from the log deterministically (with line numbers),
  // not from the LLM — so the user can always see and verify the real errors.
  if (heur.errors && heur.errors.length) result.errors = heur.errors;
  // A confident rule beats an unsure LLM: if the model is shaky but a known
  // failure pattern matched, prefer the rule's explanation.
  if (result.source === 'llm' && (result.confidence || 0) < 0.5 && heur.success && heur.rootCause) {
    console.log('LLM confidence low (' + result.confidence + '); using the rule-based diagnosis instead.');
    result.summary = heur.summary;
    result.rootCause = heur.rootCause;
    result.suggestedFixes = heur.suggestedFixes;
    result.confidence = Math.max(result.confidence || 0, heur.confidence || 0);
    result.source = 'heuristics';
  }
  return result;
}

function attachResult(result) {
  var dir = process.env.AGENT_TEMPDIRECTORY || os.tmpdir();
  var file = path.join(dir, 'ai-build-analysis.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  console.log('##vso[task.addattachment type=' + ATTACHMENT_TYPE + ';name=analysis.json;]' + file);
}

function main() {
  var collectionUri = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
  var project = process.env.SYSTEM_TEAMPROJECTID || process.env.SYSTEM_TEAMPROJECT;
  var buildId = process.env.BUILD_BUILDID;
  var jobStatus = (process.env.AGENT_JOBSTATUS || '').toLowerCase();
  var token = getAccessToken();

  if (!collectionUri || !project || !buildId) {
    console.log('##[warning]Missing pipeline environment (collection/project/buildId); skipping analysis.');
    return Promise.resolve();
  }
  if (!token) {
    console.log('##[warning]No access token available. Skipping analysis. (Is "Allow scripts to access the OAuth token" enabled, or is the job authorization scope too restrictive?)');
    return Promise.resolve();
  }
  if (jobStatus === 'succeeded') {
    console.log('Job succeeded; nothing to analyze. (Tip: run this task with condition: failed())');
    return Promise.resolve();
  }

  var cfg = {
    url: getInput('llmUrl', 'http://localhost:11434/v1'),
    model: getInput('llmModel', 'llama3.1'),
    apiKey: getInput('llmApiKey', ''),
    insecure: String(getInput('insecureTls', 'false')).toLowerCase() === 'true',
    timeout: parseInt(getInput('timeoutMs', '60000'), 10) || 60000
  };
  var maxLogs = parseInt(getInput('maxLogs', '25'), 10) || 25;
  var apiVersion = getInput('apiVersion', '6.0');
  var baseUrl = collectionUri.replace(/\/+$/, '') + '/' + encodeURIComponent(project) + '/_apis/build/builds/' + buildId;

  var meta = {
    buildNumber: process.env.BUILD_BUILDNUMBER,
    definition: process.env.BUILD_DEFINITIONNAME,
    sourceBranch: process.env.BUILD_SOURCEBRANCH,
    failedTasks: []
  };

  console.log('Reading failed-task logs for build ' + buildId + ' (api-version ' + apiVersion + ')...');
  return fetchFailureLogs(baseUrl, token, cfg.insecure, maxLogs, apiVersion)
    .then(function (logs) {
      meta.failedTasks = logs.failedTasks;
      // Extract the error-bearing sections from the FULL combined log FIRST, so an
      // error in the middle of a long (or whole-job fallback) dump is never
      // truncated away. Only the already error-focused result is then capped.
      var important = extractImportant(logs.rawLogs) || logs.rawLogs.slice(-12000);
      if (important.length > 60000) {
        important = important.slice(0, 30000) + '\n...[truncated]...\n' + important.slice(-30000);
      }

      // Deterministic baseline, always computed: it grounds the LLM and is the
      // source of truth for the quoted error lines.
      var heur = runHeuristics(important);
      console.log('Failed task(s): ' + (meta.failedTasks.join(', ') || 'n/a (used full log list)') +
        ' | extracted ' + heur.errors.length + ' key error line(s)' +
        (heur.rootCause ? ' | rule pre-check: ' + heur.rootCause : '') + '.');

      // Opt-in: read the referenced repo files from the agent's checked-out sources.
      var sourceCtx = '';
      if (String(getInput('readSource', 'false')).toLowerCase() === 'true') {
        try {
          sourceCtx = collectSourceContext(logs.rawLogs, parseInt(getInput('maxSourceBytes', '8000'), 10) || 8000);
        } catch (e) {
          console.log('##[warning]Reading source files failed: ' + e.message);
        }
        if (sourceCtx) console.log('Included repository source context (' + sourceCtx.length + ' chars).');
      }

      console.log('Analyzing with LLM at ' + cfg.url + ' (model ' + cfg.model + ')...');
      return analyzeWithLlm(important, meta, cfg, heur.rootCause, sourceCtx)
        .catch(function (e) {
          console.log('##[warning]LLM analysis failed (' + e.message + '); using offline heuristics.');
          return heur;
        })
        .then(function (result) { return mergeResult(result, heur); });
    })
    .then(function (result) {
      attachResult(result);
      console.log('Analysis attached (source: ' + result.source + ', confidence: ' + result.confidence + ').');
      console.log('Summary: ' + result.summary);
    });
}

if (require.main === module) {
  main().catch(function (e) {
    // Never fail the build because of the analyzer itself.
    console.log('##[warning]AI Build Analyzer failed: ' + (e && e.message ? e.message : e));
  });
}

// Exported for unit tests (see test/).
module.exports = { sanitize: sanitize, denoise: denoise, cleanAndNumber: cleanAndNumber, extractImportant: extractImportant, topErrorLines: topErrorLines, runHeuristics: runHeuristics, mergeResult: mergeResult, collectSourceContext: collectSourceContext };
