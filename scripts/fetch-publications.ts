// Pre-render script (run through `quarto run`, see _quarto.yml).
// Pulls the public ORCID works list, resolves every DOI to full metadata via
// Crossref (falling back to doi.org content negotiation, e.g. DataCite),
// converts it to CSL-JSON and writes ./publications.json for Quarto's citeproc.
// On any network failure the previously committed publications.json is kept.

const ORCID = "0000-0002-4124-4584";
const OUT = "publications.json";
const OVERRIDES = "scripts/publications-overrides.json";
const UA = "reneskukies-website-build (static site generator; https://reneskukies.de)";

// deno-lint-ignore no-explicit-any
type Json = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

// GET with retries (Crossref answers 429 when called too quickly).
async function getJson(url: string, accept = "application/json"): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: accept, "User-Agent": UA } });
    if (res.ok) return await res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      console.warn(`  ${res.status} for ${url}; retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new HttpError(res.status, `${res.status} ${res.statusText} for ${url}`);
  }
}

const strip = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---- author name normalisation -------------------------------------------
// Every spelling of the site owner (René / Rene / R. / R. S. / "Skukies, Rene
// Sebastian" / literal strings ...) is mapped to one canonical author so that
// the bold-author Lua filter reliably finds it in the APA output.
function isMe(family: string, given: string, literal: string): boolean {
  const re = /sk[uü]k+ies/;
  return re.test(fold(family)) || re.test(fold(given)) || re.test(fold(literal));
}

function normaliseAuthors(authors: Json[] | undefined): Json[] {
  return (authors ?? []).map((a) => {
    const family = a.family ?? "", given = a.given ?? "", literal = a.literal ?? "";
    if (isMe(family, given, literal)) return { family: "Skukies", given: "René" };
    if (literal && !family) return { literal };
    return { family, given };
  });
}

// ---- Crossref -> CSL-JSON ------------------------------------------------
const TYPE_MAP: Record<string, string> = {
  "journal-article": "article-journal",
  "posted-content": "article",
  "proceedings-article": "paper-conference",
  "book-chapter": "chapter",
  "book": "book",
  "dissertation": "thesis",
  "report": "report",
  "dataset": "dataset",
};

function fromCrossref(doi: string, m: Json): Json {
  const csl: Json = {
    id: doi,
    DOI: doi,
    URL: `https://doi.org/${doi}`,
    type: TYPE_MAP[m.type] ?? "article",
    title: strip((m.title ?? [""])[0]),
    author: normaliseAuthors(m.author),
    publisher: m.publisher,
    issued: m.issued ?? m.published ?? m["published-online"] ?? m["published-print"],
  };
  if (m["container-title"]?.length) csl["container-title"] = strip(m["container-title"][0]);
  if (m.volume) csl.volume = m.volume;
  if (m.issue) csl.issue = m.issue;
  if (m.page) csl.page = m.page;
  else if (m["article-number"]) csl.number = m["article-number"];
  if (m.type === "posted-content") {
    csl.genre = "Preprint";
    // APA prints the preprint server (bioRxiv, PsyArXiv, ...) as the source.
    const server = m.institution?.[0]?.name ?? m["group-title"];
    if (server) {
      csl.publisher = server;
      delete csl["container-title"];
    }
  }
  return csl;
}

function isPreprint(csl: Json, orcidType: string): boolean {
  return orcidType === "preprint" || csl.genre === "Preprint";
}

async function fetchCsl(doi: string): Promise<Json> {
  try {
    const m = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)).message;
    return fromCrossref(doi, m);
  } catch (e) {
    // Only fall back for DOIs Crossref does not know (e.g. DataCite).
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
    console.warn(`  Crossref failed for ${doi} (${e}); trying doi.org`);
    const c = await getJson(`https://doi.org/${doi}`, "application/vnd.citationstyles.csl+json");
    c.id = doi;
    c.author = normaliseAuthors(c.author);
    return c;
  }
}

// ---- duplicate (preprint vs. published version) detection ----------------
const words = (t: string) =>
  new Set(fold(t).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));

function similar(a: Json, b: Json): boolean {
  const A = words(a.title), B = words(b.title);
  const inter = [...A].filter((w) => B.has(w)).length;
  const jac = inter / (A.size + B.size - inter || 1);
  const fa = fold(a.author?.[0]?.family ?? ""), fb = fold(b.author?.[0]?.family ?? "");
  return jac >= 0.8 || (jac >= 0.5 && fa !== "" && fa === fb);
}

// ---- main ----------------------------------------------------------------
async function main() {
  const overrides = JSON.parse(await Deno.readTextFile(OVERRIDES));
  const exclude = new Set<string>((overrides.exclude ?? []).map((d: string) => d.toLowerCase()));

  const works = await getJson(`https://pub.orcid.org/v3.0/${ORCID}/works`);
  const entries: { csl: Json; orcidType: string }[] = [];
  const seen = new Set<string>();

  for (const g of works.group ?? []) {
    const doi = (g["external-ids"]?.["external-id"] ?? [])
      .find((e: Json) => e["external-id-type"] === "doi")?.["external-id-value"]
      ?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    if (!doi) {
      console.log(`  skipping group without DOI: ${g["work-summary"]?.[0]?.title?.title?.value}`);
      continue;
    }
    const key = doi.toLowerCase();
    if (seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    console.log(`Fetching ${doi}`);
    const csl = await fetchCsl(doi);
    Object.assign(csl, overrides.patch?.[doi] ?? {});
    entries.push({ csl, orcidType: g["work-summary"]?.[0]?.type ?? "" });
    await sleep(1000);
  }

  // Drop preprints that have a published counterpart.
  const published = entries.filter((e) => !isPreprint(e.csl, e.orcidType));
  const kept = entries.filter((e) =>
    !isPreprint(e.csl, e.orcidType) || !published.some((p) => similar(p.csl, e.csl))
  );
  for (const d of entries.filter((e) => !kept.includes(e))) {
    console.log(`Dropped preprint with published version: ${d.csl.title}`);
  }

  const result = [...kept.map((e) => e.csl), ...(overrides.extra ?? [])]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const json = JSON.stringify(result, null, 2) + "\n";
  let old = "";
  try {
    old = await Deno.readTextFile(OUT);
  } catch { /* first run */ }
  if (old !== json) {
    await Deno.writeTextFile(OUT, json);
    console.log(`Wrote ${OUT} with ${result.length} entries`);
  } else {
    console.log(`${OUT} unchanged (${result.length} entries)`);
  }
}

try {
  await main();
} catch (e) {
  console.warn(`WARNING: could not refresh publications (${e}).`);
  try {
    await Deno.stat(OUT);
    console.warn(`Keeping the existing ${OUT}.`);
  } catch {
    console.error(`No cached ${OUT} available - cannot continue.`);
    Deno.exit(1);
  }
}
