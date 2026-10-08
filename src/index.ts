interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}
/**
 * SEC Schedule 13D / 13G — structured beneficial-ownership filings.
 *
 * A Schedule 13D/13G discloses who holds 5%+ of a public company's stock and
 * how (sole vs shared voting/dispositive power), plus — for 13D — WHY (Item 4
 * "Purpose of Transaction"), which is the activist-investor signal. SEC's
 * 2024 structured-data rule requires these be filed as machine-readable XML
 * (`SCHEDULE 13D` / `SCHEDULE 13G` form types, `primary_doc.xml`); filings
 * from before the rule's effective date (2024-09-30 for 13D-family forms)
 * were filed as plain HTML/text under the older `SC 13D` / `SC 13G` form
 * types and carry no structured fields — this pack says so explicitly
 * (`structured: false`) rather than silently returning nothing.
 *
 * Tools:
 * - sec_13d_filings: list 13D/13G/13D-A/13G-A filings for an issuer (ticker or CIK)
 * - sec_13d_filing: parse one filing — reporting owners, percent of class,
 *   voting/dispositive power, Item 4 purpose, group members (structured XML),
 *   with a plain-text fallback for pre-2024 filings
 * - sec_13d_amendment_diff: what changed vs. the prior filing in the same
 *   reporting group's chain (ownership %, voting power, purpose text)
 *
 * Reuses the shared SEC entity resolver (`resolveSecEntity`, also used by the
 * `edgar` pack) rather than re-implementing ticker/CIK resolution — one
 * EDGAR identity resolver for every SEC-keyed pack.
 *
 * SEC egress note: every SEC/EDGAR pack in this fleet shares ONE outbound IP.
 * Every tool here reads a handful of specific filings (one submissions-index
 * fetch, one-or-few filing fetches) — never a bulk crawl — and sends a
 * declared User-Agent per SEC's developer guidelines.
 */


// Every outbound call goes through here — bounds the fetch so a degraded
// upstream can't hold the Worker open past its own execution budget, and
// sends the declared User-Agent SEC's guidelines ask for (data.sec.gov and
// www.sec.gov both 403 a UA-less request).
const UA = 'Pipeworx/1.0 (support@pipeworx.io)';
const SEC_HEADERS: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'SEC 13D/13G');
}

const DATA_BASE = 'https://data.sec.gov';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const MAX_DOC_BYTES = 4_000_000;
// Bound on how many PRIOR filings sec_13d_amendment_diff will fetch while
// walking back through an issuer's filing history looking for the same
// reporting group's last filing. Keeps every call to a handful of specific
// filing fetches — never a bulk crawl of the issuer's whole history.
const MAX_CHAIN_SCAN = 6;

// ── Tool definitions ─────────────────────────────────────────────────

const reportingOwnerSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    cik: { type: ['string', 'null'] },
    citizenship_or_organization: { type: ['string', 'null'] },
    type_of_reporting_person: { type: 'array', items: { type: 'string' } },
    sole_voting_power: { type: ['number', 'null'] },
    shared_voting_power: { type: ['number', 'null'] },
    sole_dispositive_power: { type: ['number', 'null'] },
    shared_dispositive_power: { type: ['number', 'null'] },
    aggregate_amount_owned: { type: ['number', 'null'] },
    percent_of_class: { type: ['number', 'null'] },
    member_of_group_box: { type: ['string', 'null'] },
  },
  required: ['name'],
};

const filingRowSchema = {
  type: 'object',
  properties: {
    accession_number: { type: 'string' },
    form: { type: 'string' },
    form_family: { type: 'string' },
    is_amendment: { type: 'boolean' },
    filing_date: { type: 'string' },
    structured: { type: 'boolean' },
    primary_document: { type: 'string' },
    filing_index_url: { type: 'string' },
    primary_document_url: { type: 'string' },
  },
  required: ['accession_number', 'form', 'is_amendment', 'filing_date', 'structured', 'filing_index_url'],
};

const tools: McpToolExport['tools'] = [
  {
    name: 'sec_13d_filings',
    description:
      'List Schedule 13D / 13G beneficial-ownership filings (and their amendments, 13D/A and 13G/A) for one issuer — AUTHORITATIVE source for "who owns 5%+ of $TICKER" and "has an activist filed a 13D on this company". Takes a ticker or company name (auto-resolved to CIK) or a CIK directly. Each row flags `structured: true/false` — filings from SEC\'s 2024 XML rule onward are structured and feed straight into sec_13d_filing; older ones are plain text/HTML only. Use sec_13d_filing on any accession_number returned here to get the actual reporting-owner data (percent of class, voting power, purpose).',
    summary: 'List 13D/13G filings (plus amendments) for an issuer, newest first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: { type: 'string', description: 'Stock ticker ("GME"), company name ("GameStop"), or SEC CIK, of the ISSUER whose beneficial-ownership filings to list.' },
        ticker: { type: 'string', description: 'Alias for ticker_or_cik.' },
        cik: { type: 'string', description: 'Alias for ticker_or_cik.' },
        form_type: {
          type: 'string',
          enum: ['all', '13D', '13D/A', '13G', '13G/A'],
          description: 'Filter to one form family. "13D" / "13G" exclude amendments; "13D/A" / "13G/A" are amendments only. Default "all".',
        },
        limit: { type: 'number', description: 'Max rows to return (1-40, default 20).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cik: { type: 'string' },
        issuer_name: { type: 'string' },
        tickers: { type: 'array', items: { type: 'string' } },
        filter_form_type: { type: 'string' },
        returned: { type: 'number' },
        filings: { type: 'array', items: filingRowSchema },
        data_as_of: { type: 'string' },
      },
      required: ['cik', 'issuer_name', 'returned', 'filings', 'data_as_of'],
    },
  },
  {
    name: 'sec_13d_filing',
    description:
      'Parse ONE Schedule 13D or 13G filing by issuer + accession_number (get the accession_number from sec_13d_filings). Returns every reporting owner (the "group members") with percent of class, sole/shared voting power, sole/shared dispositive power, and aggregate shares owned; for Schedule 13D, also Item 4 — the free-text "Purpose of Transaction", which is where an activist states its intent (board seats, a merger, liquidation, or "no plans"). Filings from before SEC\'s 2024 structured-XML rule have no machine-readable fields — this returns `structured: false` plus the bounded plain text of the filing instead of silently returning empty data.',
    summary: 'Parse one 13D/13G filing: reporting owners, voting power, percent of class, Item 4 purpose.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: { type: 'string', description: 'Ticker, company name, or CIK of the ISSUER the filing is about (same value you passed to sec_13d_filings).' },
        ticker: { type: 'string', description: 'Alias for ticker_or_cik.' },
        cik: { type: 'string', description: 'Alias for ticker_or_cik.' },
        accession_number: { type: 'string', description: 'The filing\'s SEC accession number, e.g. "0001104659-25-086308" (dashes optional). From sec_13d_filings.' },
      },
      required: ['accession_number'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cik: { type: 'string' },
        issuer_name: { type: 'string' },
        accession_number: { type: 'string' },
        form: { type: 'string' },
        form_family: { type: 'string' },
        is_amendment: { type: 'boolean' },
        structured: { type: 'boolean' },
        filing_index_url: { type: 'string' },
        primary_document_url: { type: 'string' },
        securities_class_title: { type: ['string', 'null'] },
        event_date: { type: ['string', 'null'] },
        reporting_owners: { type: 'array', items: reportingOwnerSchema },
        item4_purpose: { type: ['string', 'null'] },
        items: { type: 'object' },
        raw_text: { type: ['string', 'null'] },
        raw_text_truncated: { type: ['boolean', 'null'] },
        note: { type: ['string', 'null'] },
        data_as_of: { type: 'string' },
      },
      required: ['cik', 'issuer_name', 'accession_number', 'form', 'is_amendment', 'structured', 'filing_index_url', 'data_as_of'],
    },
  },
  {
    name: 'sec_13d_amendment_diff',
    description:
      'Given one 13D/A or 13G/A amendment (issuer + accession_number), find the SAME reporting group\'s prior filing in the chain and diff what changed: percent of class, aggregate shares owned, sole/shared voting & dispositive power (per reporting owner, matched by CIK or name), and — for 13D — whether the Item 4 purpose text changed. Walks back through the issuer\'s filing history (bounded, never a bulk crawl) matching on reporting-owner identity, since EDGAR does not carry an explicit "previous accession" link for this form family. Reports `prior_filing_found: false` honestly if no matching prior filing turns up within the scan bound, or if the chain predates the structured-XML rule (diffing free text is not meaningful).',
    summary: 'Diff a 13D/A or 13G/A amendment against the same reporting group\'s prior filing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: { type: 'string', description: 'Ticker, company name, or CIK of the ISSUER.' },
        ticker: { type: 'string', description: 'Alias for ticker_or_cik.' },
        cik: { type: 'string', description: 'Alias for ticker_or_cik.' },
        accession_number: { type: 'string', description: 'Accession number of the AMENDMENT (13D/A or 13G/A) to diff against its predecessor. Also accepts an original 13D/13G, in which case there is by definition no prior filing.' },
      },
      required: ['accession_number'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cik: { type: 'string' },
        issuer_name: { type: 'string' },
        current: filingRowSchema,
        prior_filing_found: { type: 'boolean' },
        prior: { type: ['object', 'null'] },
        scanned: { type: 'number' },
        scan_limit: { type: 'number' },
        changes: { type: ['object', 'null'] },
        note: { type: ['string', 'null'] },
        data_as_of: { type: 'string' },
      },
      required: ['cik', 'issuer_name', 'current', 'prior_filing_found', 'scanned', 'scan_limit', 'data_as_of'],
    },
  },
];

// ── Shared submissions / identity plumbing ──────────────────────────

function padCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0');
}

function isNumericCik(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function pickTickerOrCik(args: Record<string, unknown>): string {
  const value = args.ticker_or_cik ?? args.ticker ?? args.cik;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'An issuer is required: pass `ticker_or_cik` (or its aliases `ticker` / `cik`) — a stock ' +
      'ticker ("GME"), a company name ("GameStop"), or an SEC CIK ("1326380").'
    );
  }
  return value.trim();
}

async function resolveCik(tickerOrCik: string): Promise<{ cik: string; name?: string; tickers?: string[] }> {
  if (isNumericCik(tickerOrCik)) return { cik: tickerOrCik };
  const entity = await resolveSecEntity(tickerOrCik, { headers: SEC_HEADERS });
  return { cik: entity.cik, name: entity.company_name, tickers: [entity.ticker] };
}

interface SubmissionsPayload {
  cik: string;
  name: string;
  tickers: string[];
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
}

function submissionsError(status: number, tickerOrCik: string, paddedCik: string): Error {
  if (status === 404) {
    return new Error(
      `No SEC registrant with CIK ${paddedCik} (resolved from "${tickerOrCik}"). The company may ` +
      'be private, foreign-listed, or the identifier may be wrong — try sec_13d_filings with a ' +
      'different ticker or company name.'
    );
  }
  return new Error(`SEC EDGAR submissions error: ${status}`);
}

async function fetchSubmissions(tickerOrCik: string, paddedCik: string): Promise<SubmissionsPayload> {
  const res = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw submissionsError(res.status, tickerOrCik, paddedCik);
  return (await res.json()) as SubmissionsPayload;
}

// 13D/13G form strings changed shape with SEC's 2024 structured-data rule:
// "SC 13D" / "SC 13D/A" (pre-rule, plain text) vs "SCHEDULE 13D" /
// "SCHEDULE 13D/A" (post-rule, structured XML). Normalize both to one family
// label so callers filtering on "13D" get both eras.
function formFamily(form: string): '13D' | '13G' | 'other' {
  const f = form.toUpperCase();
  if (f.includes('13D')) return '13D';
  if (f.includes('13G')) return '13G';
  return 'other';
}

function isAmendmentForm(form: string): boolean {
  return form.toUpperCase().includes('/A');
}

function isStructuredForm(form: string): boolean {
  // Only the post-2024-rule "SCHEDULE 13D"/"SCHEDULE 13G" form strings carry
  // structured XML as their primary document; "SC 13D"/"SC 13G" never do.
  return form.toUpperCase().startsWith('SCHEDULE 13');
}

interface FilingRow {
  accession_number: string;
  form: string;
  form_family: '13D' | '13G' | 'other';
  is_amendment: boolean;
  filing_date: string;
  structured: boolean;
  primary_document: string;
  filing_index_url: string;
  primary_document_url: string;
}

function buildFilingRow(cik: string, accession: string, form: string, filingDate: string, primaryDocument: string): FilingRow {
  const accessionPath = accession.replace(/-/g, '');
  const structured = isStructuredForm(form) && /\.xml$/i.test(primaryDocument);
  // EDGAR's submissions `primaryDocument` for a structured 13D/13G is the
  // XSLT VIEWER path ("xslSCHEDULE_13D_X01/primary_doc.xml") — fetching that
  // exact URL returns rendered HTML, not machine-readable XML, even though
  // the filename says .xml (confirmed live: identical suffix, different
  // content-type). The actual raw XML always sits at `primary_doc.xml`
  // directly in the accession's archive root, regardless of the viewer's
  // stylesheet variant (X01/X02/…) — same convention mcps/sec-form-d relies
  // on for Form D. Point structured filings there; leave non-structured
  // (plain .htm/.txt) filings' URL as the submissions-listed document.
  const primaryDocumentUrl = structured
    ? `${ARCHIVES_BASE}/${Number(cik)}/${accessionPath}/primary_doc.xml`
    : `${ARCHIVES_BASE}/${Number(cik)}/${accessionPath}/${primaryDocument}`;
  return {
    accession_number: accession,
    form,
    form_family: formFamily(form),
    is_amendment: isAmendmentForm(form),
    filing_date: filingDate,
    structured,
    primary_document: primaryDocument,
    filing_index_url: `${ARCHIVES_BASE}/${Number(cik)}/${accessionPath}/${accession}-index.htm`,
    primary_document_url: primaryDocumentUrl,
  };
}

function recent13dgRows(data: SubmissionsPayload, keep: (form: string) => boolean, count: number): FilingRow[] {
  const recent = data.filings.recent;
  const rows: FilingRow[] = [];
  for (let i = 0; i < recent.accessionNumber.length && rows.length < count; i++) {
    const form = recent.form[i];
    if (formFamily(form) === 'other') continue;
    if (!keep(form)) continue;
    rows.push(buildFilingRow(data.cik, recent.accessionNumber[i], form, recent.filingDate[i], recent.primaryDocument[i]));
  }
  return rows;
}

function dataAsOf(): string {
  return new Date().toISOString();
}

// ── sec_13d_filings ──────────────────────────────────────────────────

async function listFilings(args: Record<string, unknown>) {
  const tickerOrCik = pickTickerOrCik(args);
  const { cik } = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const data = await fetchSubmissions(tickerOrCik, paddedCik);

  const formTypeArg = typeof args.form_type === 'string' ? args.form_type : 'all';
  const count = Math.min(40, Math.max(1, Number(args.limit) || 20));

  const keep = (form: string): boolean => {
    if (formTypeArg === 'all') return true;
    const family = formFamily(form);
    const amendment = isAmendmentForm(form);
    if (formTypeArg === '13D') return family === '13D' && !amendment;
    if (formTypeArg === '13D/A') return family === '13D' && amendment;
    if (formTypeArg === '13G') return family === '13G' && !amendment;
    if (formTypeArg === '13G/A') return family === '13G' && amendment;
    return true;
  };

  const filings = recent13dgRows(data, keep, count);

  return {
    cik: data.cik,
    issuer_name: data.name,
    tickers: data.tickers ?? [],
    filter_form_type: formTypeArg,
    returned: filings.length,
    filings,
    data_as_of: dataAsOf(),
  };
}

// ── XML parsing helpers (mirrors mcps/sec-form-d's regex tag reader —
//    Workers has no DOMParser, and these filings are small enough that a
//    regex pass over the whole document is cheap and has already proven
//    itself safe against this exact SEC XML shape) ─────────────────────

function tag(xml: string, name: string): string | null {
  const value = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1];
  return value == null ? null : decodeXml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) || null;
}

function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi'))]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
}

function block(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'i'))?.[0] ?? '';
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'gi'))].map((match) => match[0]);
}

function numberTag(xml: string, name: string): number | null {
  const value = tag(xml, name);
  if (value == null) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

interface ReportingOwner {
  name: string;
  cik: string | null;
  citizenship_or_organization: string | null;
  type_of_reporting_person: string[];
  sole_voting_power: number | null;
  shared_voting_power: number | null;
  sole_dispositive_power: number | null;
  shared_dispositive_power: number | null;
  aggregate_amount_owned: number | null;
  percent_of_class: number | null;
  member_of_group_box: string | null;
}

// Schedule 13D's <reportingPersonInfo> and 13G's
// <coverPageHeaderReportingPersonDetails> carry the same substance under
// different tag names (13D nests voting power directly; 13G nests it one
// level deeper under <reportingPersonBeneficiallyOwnedNumberOfShares>).
// Unify both into one ReportingOwner shape so callers don't need to know
// which schedule they're looking at.
function parseReportingOwners13D(xml: string): ReportingOwner[] {
  return blocks(xml, 'reportingPersonInfo').map((b) => ({
    name: tag(b, 'reportingPersonName') ?? 'unknown',
    cik: tag(b, 'reportingPersonCIK'),
    citizenship_or_organization: tag(b, 'citizenshipOrOrganization'),
    type_of_reporting_person: tags(b, 'typeOfReportingPerson'),
    sole_voting_power: numberTag(b, 'soleVotingPower'),
    shared_voting_power: numberTag(b, 'sharedVotingPower'),
    sole_dispositive_power: numberTag(b, 'soleDispositivePower'),
    shared_dispositive_power: numberTag(b, 'sharedDispositivePower'),
    aggregate_amount_owned: numberTag(b, 'aggregateAmountOwned'),
    percent_of_class: numberTag(b, 'percentOfClass'),
    member_of_group_box: tag(b, 'memberOfGroup'),
  }));
}

function parseReportingOwners13G(xml: string): ReportingOwner[] {
  return blocks(xml, 'coverPageHeaderReportingPersonDetails').map((b) => {
    const sharesBlock = block(b, 'reportingPersonBeneficiallyOwnedNumberOfShares');
    return {
      name: tag(b, 'reportingPersonName') ?? 'unknown',
      cik: tag(b, 'reportingPersonCIK'),
      citizenship_or_organization: tag(b, 'citizenshipOrOrganization'),
      type_of_reporting_person: tags(b, 'typeOfReportingPerson'),
      sole_voting_power: numberTag(sharesBlock, 'soleVotingPower'),
      shared_voting_power: numberTag(sharesBlock, 'sharedVotingPower'),
      sole_dispositive_power: numberTag(sharesBlock, 'soleDispositivePower'),
      shared_dispositive_power: numberTag(sharesBlock, 'sharedDispositivePower'),
      aggregate_amount_owned: numberTag(b, 'reportingPersonBeneficiallyOwnedAggregateNumberOfShares'),
      percent_of_class: numberTag(b, 'classPercent'),
      member_of_group_box: null,
    };
  });
}

interface ParsedFiling {
  securities_class_title: string | null;
  event_date: string | null;
  reporting_owners: ReportingOwner[];
  item4_purpose: string | null;
  items: Record<string, string>;
}

function parseStructuredFiling(xml: string, family: '13D' | '13G'): ParsedFiling {
  if (family === '13D') {
    const items1to7 = block(xml, 'items1To7');
    const items: Record<string, string> = {};
    for (let n = 1; n <= 7; n++) {
      const itemXml = block(items1to7, `item${n}`);
      if (itemXml) items[`item${n}`] = itemXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return {
      securities_class_title: tag(xml, 'securitiesClassTitle'),
      event_date: tag(xml, 'dateOfEvent'),
      reporting_owners: parseReportingOwners13D(xml),
      item4_purpose: tag(block(items1to7, 'item4'), 'transactionPurpose'),
      items,
    };
  }
  // 13G: items 1-10, no single free-text "purpose" field — Item 4 here is
  // "Ownership" (amount/percent/voting power), already covered by
  // reporting_owners, so item4_purpose stays null with a note at the caller.
  const itemsBlock = block(xml, 'items');
  const items: Record<string, string> = {};
  for (let n = 1; n <= 10; n++) {
    const itemXml = block(itemsBlock, `item${n}`);
    if (itemXml) items[`item${n}`] = itemXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return {
    securities_class_title: tag(xml, 'securitiesClassTitle'),
    event_date: tag(xml, 'eventDateRequiresFilingThisStatement'),
    reporting_owners: parseReportingOwners13G(xml),
    item4_purpose: null,
    items,
  };
}

async function fetchTextBounded(url: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const res = await pwFetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Failed to fetch filing document (HTTP ${res.status}): ${url}`);
  if (!res.body) {
    const whole = await res.text();
    return { text: whole.length > maxBytes ? whole.slice(0, maxBytes) : whole, truncated: whole.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) { truncated = true; await reader.cancel(); break; }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(buf), truncated };
}

function htmlToText(html: string): string {
  return decodeXml(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findFilingRow(data: SubmissionsPayload, accession: string): FilingRow | null {
  const normalized = accession.replace(/\D/g, '');
  const recent = data.filings.recent;
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    if (recent.accessionNumber[i].replace(/\D/g, '') === normalized) {
      const form = recent.form[i];
      if (formFamily(form) === 'other') return null;
      return buildFilingRow(data.cik, recent.accessionNumber[i], form, recent.filingDate[i], recent.primaryDocument[i]);
    }
  }
  return null;
}

// ── sec_13d_filing ───────────────────────────────────────────────────

async function getFiling(args: Record<string, unknown>) {
  const tickerOrCik = pickTickerOrCik(args);
  const accessionArg = typeof args.accession_number === 'string' ? args.accession_number : '';
  if (!accessionArg.trim()) throw new Error('accession_number is required — get one from sec_13d_filings.');

  const { cik } = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const data = await fetchSubmissions(tickerOrCik, paddedCik);
  const row = findFilingRow(data, accessionArg);
  if (!row) {
    throw new Error(
      `No 13D/13G filing with accession "${accessionArg}" found for ${data.name} (CIK ${data.cik}). ` +
      'Call sec_13d_filings first to get a valid accession_number for this issuer.'
    );
  }

  if (!row.structured) {
    const { text, truncated } = await fetchTextBounded(row.primary_document_url, MAX_DOC_BYTES);
    const plain = /\.(htm|html)$/i.test(row.primary_document) ? htmlToText(text) : text;
    return {
      cik: data.cik,
      issuer_name: data.name,
      accession_number: row.accession_number,
      form: row.form,
      form_family: row.form_family,
      is_amendment: row.is_amendment,
      structured: false,
      filing_index_url: row.filing_index_url,
      primary_document_url: row.primary_document_url,
      securities_class_title: null,
      event_date: null,
      reporting_owners: [],
      item4_purpose: null,
      items: {},
      raw_text: plain,
      raw_text_truncated: truncated,
      note: `This filing (${row.form}, filed ${row.filing_date}) predates SEC's 2024 structured-XML rule for Schedule 13D/13G — no machine-readable fields exist, so this is the filing's plain text instead.`,
      data_as_of: dataAsOf(),
    };
  }

  const xml = (await fetchTextBounded(row.primary_document_url, MAX_DOC_BYTES)).text;
  const parsed = parseStructuredFiling(xml, row.form_family === '13G' ? '13G' : '13D');

  return {
    cik: data.cik,
    issuer_name: data.name,
    accession_number: row.accession_number,
    form: row.form,
    form_family: row.form_family,
    is_amendment: row.is_amendment,
    structured: true,
    filing_index_url: row.filing_index_url,
    primary_document_url: row.primary_document_url,
    securities_class_title: parsed.securities_class_title,
    event_date: parsed.event_date,
    reporting_owners: parsed.reporting_owners,
    item4_purpose: parsed.item4_purpose,
    items: parsed.items,
    raw_text: null,
    raw_text_truncated: null,
    note: row.form_family === '13G'
      ? 'Schedule 13G has no Item 4 "purpose" field (that is specific to 13D) — Item 4 here is "Ownership", already reflected in reporting_owners.'
      : null,
    data_as_of: dataAsOf(),
  };
}

// ── sec_13d_amendment_diff ───────────────────────────────────────────

function ownerKey(owner: ReportingOwner): string {
  return (owner.cik && owner.cik.trim()) || owner.name.toUpperCase().trim();
}

function numDiff(a: number | null, b: number | null): { from: number | null; to: number | null; changed: boolean } {
  return { from: a, to: b, changed: a !== b };
}

async function diffAmendment(args: Record<string, unknown>) {
  const tickerOrCik = pickTickerOrCik(args);
  const accessionArg = typeof args.accession_number === 'string' ? args.accession_number : '';
  if (!accessionArg.trim()) throw new Error('accession_number is required — get one from sec_13d_filings.');

  const { cik } = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const data = await fetchSubmissions(tickerOrCik, paddedCik);

  const currentRow = findFilingRow(data, accessionArg);
  if (!currentRow) {
    throw new Error(
      `No 13D/13G filing with accession "${accessionArg}" found for ${data.name} (CIK ${data.cik}). ` +
      'Call sec_13d_filings first to get a valid accession_number for this issuer.'
    );
  }
  if (!currentRow.structured) {
    return {
      cik: data.cik,
      issuer_name: data.name,
      current: currentRow,
      prior_filing_found: false,
      prior: null,
      scanned: 0,
      scan_limit: MAX_CHAIN_SCAN,
      changes: null,
      note: `${currentRow.form} (filed ${currentRow.filing_date}) predates SEC's 2024 structured-XML rule — it has no machine-readable fields, so there is nothing to diff. Use sec_13d_filing to read its plain text.`,
      data_as_of: dataAsOf(),
    };
  }

  const currentXml = (await fetchTextBounded(currentRow.primary_document_url, MAX_DOC_BYTES)).text;
  const currentParsed = parseStructuredFiling(currentXml, currentRow.form_family === '13G' ? '13G' : '13D');
  const currentOwnerKeys = new Set(currentParsed.reporting_owners.map(ownerKey));
  // `previousAccessionNumber` (present on most, not all, structured
  // amendments — a later XSD revision, X02, dropped it for some filers) is
  // EDGAR's own pointer, but it points to the ORIGINAL filing in the chain,
  // not the immediately-preceding amendment — confirmed live: three
  // successive IMXI/Voss Capital amendments all carry the SAME
  // previousAccessionNumber (the 2024 original). So it identifies chain
  // MEMBERSHIP, not "the prior filing" directly; used below as a second
  // signal alongside reporting-owner overlap when scanning backward for the
  // nearest actual predecessor.
  const currentPrevAccession = tag(currentXml, 'previousAccessionNumber')?.replace(/\D/g, '') || null;

  // Walk the issuer's filing history backward from the current filing's date,
  // same form family only, looking for the most recent STRUCTURED filing that
  // is part of the SAME reporting group's chain — either its reporting-owner
  // set overlaps this one's, or its own accession IS this chain's original
  // (previousAccessionNumber), or it declares the same previousAccessionNumber
  // as this filing. Bounded scan: never more than MAX_CHAIN_SCAN filing
  // fetches, so this stays a handful of specific reads, not a crawl of the
  // issuer's whole 13D/13G history.
  const recent = data.filings.recent;
  const candidates: FilingRow[] = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const form = recent.form[i];
    if (formFamily(form) !== currentRow.form_family) continue;
    if (recent.accessionNumber[i].replace(/\D/g, '') === currentRow.accession_number.replace(/\D/g, '')) continue;
    if (recent.filingDate[i] > currentRow.filing_date) continue;
    candidates.push(buildFilingRow(data.cik, recent.accessionNumber[i], form, recent.filingDate[i], recent.primaryDocument[i]));
  }
  // Newest-first (submissions.json is already newest-first, but be explicit).
  candidates.sort((a, b) => (a.filing_date < b.filing_date ? 1 : a.filing_date > b.filing_date ? -1 : 0));

  let scanned = 0;
  let priorRow: FilingRow | null = null;
  let priorParsed: ParsedFiling | null = null;
  for (const candidate of candidates) {
    if (scanned >= MAX_CHAIN_SCAN) break;
    if (!candidate.structured) continue; // can't diff free text against structured fields
    // The candidate IS this chain's original filing — no fetch needed to know
    // that; EDGAR's own pointer says so directly.
    const candidateAccessionDigits = candidate.accession_number.replace(/\D/g, '');
    const isDeclaredOriginal = currentPrevAccession != null && candidateAccessionDigits === currentPrevAccession;
    scanned++;
    const candidateXml = (await fetchTextBounded(candidate.primary_document_url, MAX_DOC_BYTES)).text;
    const candidateParsed = parseStructuredFiling(candidateXml, candidate.form_family === '13G' ? '13G' : '13D');
    const ownerOverlap = candidateParsed.reporting_owners.some((o) => currentOwnerKeys.has(ownerKey(o)));
    const sameDeclaredChain = currentPrevAccession != null
      && tag(candidateXml, 'previousAccessionNumber')?.replace(/\D/g, '') === currentPrevAccession;
    if (isDeclaredOriginal || sameDeclaredChain || ownerOverlap) {
      priorRow = candidate;
      priorParsed = candidateParsed;
      break;
    }
  }

  if (!priorRow || !priorParsed) {
    return {
      cik: data.cik,
      issuer_name: data.name,
      current: currentRow,
      prior_filing_found: false,
      prior: null,
      scanned,
      scan_limit: MAX_CHAIN_SCAN,
      changes: null,
      note: scanned >= MAX_CHAIN_SCAN
        ? `No prior filing by this reporting group turned up in the ${MAX_CHAIN_SCAN} most recent same-family filings scanned backward — it may be further back than this tool's scan bound, or this may be the group's first filing.`
        : 'No prior filing by this reporting group exists in this issuer\'s filing history — this is apparently the group\'s first 13D/13G on this issuer.',
      data_as_of: dataAsOf(),
    };
  }

  const priorOwnersByKey = new Map(priorParsed.reporting_owners.map((o) => [ownerKey(o), o]));
  const ownerChanges = currentParsed.reporting_owners.map((cur) => {
    const prior = priorOwnersByKey.get(ownerKey(cur));
    return {
      name: cur.name,
      cik: cur.cik,
      new_reporting_owner: !prior,
      percent_of_class: prior ? numDiff(prior.percent_of_class, cur.percent_of_class) : numDiff(null, cur.percent_of_class),
      aggregate_amount_owned: prior ? numDiff(prior.aggregate_amount_owned, cur.aggregate_amount_owned) : numDiff(null, cur.aggregate_amount_owned),
      sole_voting_power: prior ? numDiff(prior.sole_voting_power, cur.sole_voting_power) : numDiff(null, cur.sole_voting_power),
      shared_voting_power: prior ? numDiff(prior.shared_voting_power, cur.shared_voting_power) : numDiff(null, cur.shared_voting_power),
      sole_dispositive_power: prior ? numDiff(prior.sole_dispositive_power, cur.sole_dispositive_power) : numDiff(null, cur.sole_dispositive_power),
      shared_dispositive_power: prior ? numDiff(prior.shared_dispositive_power, cur.shared_dispositive_power) : numDiff(null, cur.shared_dispositive_power),
    };
  });
  const removedOwners = priorParsed.reporting_owners
    .filter((o) => !currentOwnerKeys.has(ownerKey(o)))
    .map((o) => ({ name: o.name, cik: o.cik }));

  const purposeChanged = currentRow.form_family === '13D'
    ? (currentParsed.item4_purpose ?? '') !== (priorParsed.item4_purpose ?? '')
    : null;

  return {
    cik: data.cik,
    issuer_name: data.name,
    current: currentRow,
    prior_filing_found: true,
    prior: priorRow,
    scanned,
    scan_limit: MAX_CHAIN_SCAN,
    changes: {
      owners: ownerChanges,
      removed_owners: removedOwners,
      item4_purpose_changed: purposeChanged,
      item4_purpose_from: currentRow.form_family === '13D' ? priorParsed.item4_purpose : null,
      item4_purpose_to: currentRow.form_family === '13D' ? currentParsed.item4_purpose : null,
    },
    note: null,
    data_as_of: dataAsOf(),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'sec_13d_filings':
      return listFilings(args);
    case 'sec_13d_filing':
      return getFiling(args);
    case 'sec_13d_amendment_diff':
      return diffAmendment(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
