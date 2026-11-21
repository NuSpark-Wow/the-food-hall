// The Food Hall — live learning endpoint (Learn...Wow! / NuSparkLearnWow)
// Modes: "lesson" (a source-checked lesson), "ask" (a question about food), "more" (6 new topic ideas for a stall),
//        "recipe" (a simple starter recipe from the Kitchen Shelf), "compare" (another set of AI eyes)
// Honesty rule: every source shown to the visitor must be a page Claude actually retrieved with web search
// during THIS request. Unverified sources are removed. No verified sources = no lesson.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const FAST_MODEL = process.env.FAST_MODEL || "claude-haiku-5-5";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIVE_LIMIT || "25", 10);
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const STALLS = {
  origins: "Where It Comes From (farms, oceans, orchards, ranches, how food is grown, raised, caught or made, and how it reaches the store)",
  ingredients: "Ingredients (what an ingredient is, what it does in food, why it's used, common swaps, reading an ingredient label)",
  nutrition: "Nutrition (vitamins, minerals, protein, carbs, fats, fiber, what nutrients do in the body, reading a nutrition label; general education only)",
  science: "Food Science (the chemistry and physics of food and cooking: why bread rises, why onions sting, browning, freezing, fermenting)",
  world: "World Foods (cuisines and signature dishes from countries and cultures around the world, and the stories behind them)",
  history: "Food History (where foods and dishes came from, inventions, famous food firsts, how eating changed over time)",
  wow: "Wow...Who Knew? (surprising, true food facts and busted food myths)",
  tools: "The Kitchen Shelf: Kitchen Tools (what a tool is, what it's for, how it works, how to use it safely)",
  methods: "The Kitchen Shelf: Cooking Methods (baking, roasting, sauteing, steaming, braising, grilling and more: what happens to food and why)"
};

// --- simple per-IP daily limit (resets when the server instance restarts; the Anthropic spend cap is the real backstop)
const hits = new Map();
function overLimit(ip, limit) {
  const key = ip + "|" + new Date().toISOString().slice(0, 10);
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) hits.clear();
  return n > limit;
}

const SYSTEM = `You are the teaching editor of "The Food Hall," a food education tool from NuSparkLearnWow.com (part of the Learn...Wow! series from NuSpark Publishing). Your host persona is Mr. Paul, a warm, upbeat teacher wearing a chef's hat. The Food Hall is about LEARNING about food, not a cookbook.

ABSOLUTE HONESTY RULES (for lessons, answers and comparisons):
1. Use the web_search tool before answering when it is available. Answer ONLY from what the search results support. Never answer from memory alone.
2. Use ONLY strong sources (weaker sites are automatically removed): government agencies (USDA, FDA, NIH, CDC), the UN Food and Agriculture Organization (FAO), universities and extension services, museums, encyclopedias (Britannica), peer-reviewed research, established science and food-science outlets. Avoid diet blogs, forums, social media, content farms and "fun fact" list sites.
3. If reliable sources are weak, missing, or disagree, say so honestly. Never force an answer.
4. Every source you list MUST be a URL that appeared in your search results in this conversation. Never invent or guess URLs.
5. Never make anything up. No invented numbers, quotes, names or dates. Food origin stories are full of legends; when a famous story is a legend, say it is a legend.

TOPIC & SAFETY RULES:
- Stay on food: where food comes from, ingredients, nutrition, food science, world foods, food history, kitchen tools and cooking methods. Politely decline anything else with a friendly one-sentence note.
- Nutrition is general education only. No diet plans, no weight-loss advice, no calorie targets, no medical or supplement advice, no "good food / bad food" judgments. Whenever a lesson or answer touches nutrition or health, include the sentence: "For advice about your own diet or health, check with a doctor or a registered dietitian."
- Food safety facts (safe temperatures, raw foods, allergies) must come from sources like USDA, FDA or CDC.
- Everything must be family-appropriate. No alcohol how-tos. Keep national and global examples, not local ones.

WRITING STYLE:
- "grown" (adults, the default): clear, precise and interesting, with context and real numbers where sources give them. Friendly, not cutesy.
- "kids" (ages 7-12): fun and lively, short sentences, simple words, an accurate kid-friendly comparison. Fun never changes the facts.
- Never call the tool or its content "free." No markdown, no asterisks, plain sentences.

OUTPUT: Never put citation tags or markup (like <cite ...>) inside the JSON text. After your research, reply with ONLY a JSON object wrapped in <json> and </json> tags, in the exact shape the user message asks for.`;

const ALLERGY_NOTE = "Allergy check: read every ingredient label and swap out anything that you or your guests are allergic to.";
const HEALTH_NOTE = "For advice about your own diet or health, check with a doctor or a registered dietitian.";
const NOT_CONFIRMED = {
  kids: "We couldn't confirm this one with reliable sources yet, so we won't guess. Try asking it a different way!",
  grown: "We couldn't confirm this with reliable sources, so we won't guess. Try rephrasing it, or check back later."
};
const sourcesShape = `"sources": [{"title": "Publisher: page title", "url": "https://..."}]`;

function modePrompt(mode, b, level) {
  const stall = STALLS[b.stall] ? STALLS[b.stall] : "General food knowledge";
  const lvl = `Reading level: "${level}".`;
  if (mode === "lesson") {
    const topic = String(b.topic || "").slice(0, 200);
    return `Stall: ${stall}
Lesson topic: "${topic}"
${lvl}
Research this topic with web search and teach it as a short, fascinating lesson that leaves the reader saying "I didn't know that." If the topic is not about food, set "ok" to false and explain kindly in "intro".
Reply with ONLY this JSON inside <json></json>:
{"ok": true,
 "title": "a lively lesson title",
 "intro": "2-3 sentence opener",
 "sections": [{"heading": "short heading", "text": "3-5 sentences"}],   // 3 or 4 sections
 "wow": "one surprising, sourced fact from your research",
 "kitchen": "one sentence connecting this to a real kitchen (a tool, a method, or something to notice next time you cook or shop), or empty string",
 "recipeIdea": "if a simple starter recipe naturally fits this lesson, name it (e.g. 'Simple homemade butter'); otherwise empty string",
 "wiki": "the exact English Wikipedia article title that best pictures this lesson (e.g. 'Sourdough')",
 "followups": ["3 short follow-up questions a curious reader might ask next"],
 ${sourcesShape}}`;
  }
  if (mode === "ask") {
    const q = String(b.question || "").slice(0, 400);
    const ctx = b.context ? `The visitor is reading a lesson called "${String(b.context).slice(0, 160)}".` : "";
    return `${ctx}
Visitor's question about food: "${q}"
${lvl}
Research it with web search, then answer in 1-3 short paragraphs. If it isn't about food or you can't confirm it, set "confirmed" to false and say so kindly.
Reply with ONLY this JSON inside <json></json>:
{"confirmed": true, "answer": "...", "wiki": "best English Wikipedia article title to picture the answer, or empty", ${sourcesShape}}`;
  }
  if (mode === "more") {
    const ex = (Array.isArray(b.exclude) ? b.exclude : []).slice(0, 60).map(x => String(x).slice(0, 80));
    return `Stall: ${stall}
Suggest 6 NEW, specific, intriguing lesson topics for this stall that a curious adult would want to learn about. Mix everyday foods with surprising ones, from around the world. Short titles (3-8 words). Do not repeat or closely resemble any of these: ${JSON.stringify(ex)}.
Reply with ONLY this JSON inside <json></json>: {"topics": ["...", "...", "...", "...", "...", "..."]}`;
  }
  if (mode === "recipe") {
    const dish = String(b.dish || "").slice(0, 160);
    return `Kitchen Shelf starter recipe request: "${dish}"
${lvl}
Write ONE simple, beginner-friendly home recipe for this (or the closest simple version). If it is not a food or would be unsafe, set "ok" to false with a kind note in "intro". Use common ingredients and US measurements with metric in parentheses. Include any food-safety step that applies (safe cooking temperatures for meat, poultry, eggs or seafood). Keep it to 10 steps or fewer.
Reply with ONLY this JSON inside <json></json>:
{"ok": true, "title": "...", "intro": "1-2 sentences, including what the recipe teaches about food", "serves": "e.g. 4", "time": "e.g. 25 minutes",
 "ingredients": ["..."], "steps": ["..."], "learn": "one sentence of the food science or history behind this dish", "wiki": "best English Wikipedia article title for the dish"}`;
  }
  if (mode === "compare") {
    const lesson = b.lesson || {};
    return `Here is a Food Hall lesson:
TITLE: ${String(lesson.title || "").slice(0, 200)}
TEXT: ${String(lesson.text || "").slice(0, 4000)}

Here is another AI's answer on the same topic, pasted by the visitor:
${String(b.other || "").slice(0, 5000)}

Use web search to check any points where the two disagree. Then compare them honestly. Be fair: if the other AI is right and the lesson is wrong, say so.
Reply with ONLY this JSON inside <json></json>:
{"agreement": "matches" | "partly" | "differs", "summary": "2-4 sentences", "differences": ["each real difference and which side the sources support"], ${sourcesShape}}`;
  }
  return null;
}


// ---------- helpers
function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch (e) { return ""; }
}
function hostOf(u) { try { return new URL(String(u).trim()).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } }
const words = t => new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
// ---------- strong-source filter: only trusted science / education / reference sites make it into footnotes
const STRONG_SUFFIX = [".edu", ".gov", ".mil", ".int", ".ac.uk", ".gov.uk", ".edu.au", ".gov.au", ".ac.nz", ".govt.nz", ".gc.ca", ".museum", ".si.edu"];
const STRONG_HOSTS = ["sciencebuddies.org","scientificamerican.com","britannica.com","nationalgeographic.com","smithsonianmag.com","amnh.org","fi.edu","exploratorium.edu",
  "nature.com","science.org","sciencedirect.com","springer.com","link.springer.com","wiley.com","onlinelibrary.wiley.com","frontiersin.org","plos.org","journals.plos.org","arxiv.org","pnas.org","cell.com","royalsocietypublishing.org","annualreviews.org","tandfonline.com","sagepub.com","jstor.org",
  "aip.org","aps.org","physics.aps.org","iop.org","physicsworld.com","rsc.org","acs.org","pubs.acs.org","libretexts.org","openstax.org","khanacademy.org","ck12.org","physicsclassroom.com","hyperphysics.phy-astr.gsu.edu",
  "livescience.com","space.com","newscientist.com","sciencenews.org","snexplores.org","sciencedaily.com","quantamagazine.org","popsci.com","discovermagazine.com","howstuffworks.com",
  "bbc.co.uk","bbc.com","pbs.org","npr.org","wikipedia.org","en.wikipedia.org","letstalkscience.ca","scienceworld.ca","sciencemuseum.org.uk","nhm.ac.uk","nobelprize.org","sciencelearn.org.nz","apa.org","psychologytoday.com","simplypsychology.org",
  "mayoclinic.org","clevelandclinic.org","hopkinsmedicine.org","aao.org","who.int","webmd.com","healthline.com","kidshealth.org","nationalacademies.org","ieee.org","spectrum.ieee.org","asme.org","asce.org","energy.gov",
  "worldwildlife.org","nwf.org","audubon.org","oceanexplorer.noaa.gov","mbari.org","whoi.edu","metmuseum.org","history.com","loc.gov","archives.gov","nps.gov","usgs.gov","weather.gov","earthobservatory.nasa.gov","nasa.gov","noaa.gov","nih.gov","cdc.gov",
  "jpl.nasa.gov","esa.int","keckobservatory.org","planetary.org","skyandtelescope.org","astronomy.com","nationalgeographic.org","kids.nationalgeographic.com","sciencefriday.com","stevespanglerscience.com","mofad.org","ifl.science","iflscience.com","sciencenotes.org","thoughtco.com","theconversation.com","theguardian.com","nytimes.com","washingtonpost.com","reuters.com","apnews.com","time.com","smithsonian.com","ocean.si.edu","nationalzoo.si.edu","airandspace.si.edu","naturalhistory.si.edu","ucsb.edu","scienceline.ucsb.edu",
  "fao.org","eatright.org","nutrition.gov","foodsafety.gov","heart.org","ift.org","seriouseats.com","americastestkitchen.com","cooksillustrated.com","exploratorium.edu","foodprint.org","wholegrainscouncil.org","oldwayspt.org","ers.usda.gov","usda.gov","fda.gov","myplate.gov","bbcgoodfood.com","culinaryinstitute.edu","ciachef.edu","harvard.edu","nutritionsource.hsph.harvard.edu"];
function isStrong(url) {
  const h = hostOf(url); if (!h) return false;
  if (STRONG_SUFFIX.some(sfx => h.endsWith(sfx))) return true;
  return STRONG_HOSTS.some(d => h === d || h.endsWith("." + d));
}
// A source counts only if it is a page Claude actually retrieved in THIS request.
// Exact page match first. If Claude wrote the link slightly differently, we swap in the real
// retrieved page from the same website (best title match), so every link shown is a page that was really read.
function verifySources(list, retrieved) {
  const out = [];
  const seen = new Set();
  const pages = [...retrieved.values()];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.url) continue;
    let r = retrieved.get(normUrl(s.url));
    if (!r) {
      const host = hostOf(s.url);
      const want = words((s.title || "") + " " + s.url);
      let best = null, bestScore = -1;
      for (const pg of pages) {
        if (hostOf(pg.url) !== host) continue;
        const have = words(pg.title + " " + pg.url);
        let score = 0; want.forEach(w => { if (have.has(w)) score++; });
        if (score > bestScore) { best = pg; bestScore = score; }
      }
      r = best;
    }
    if (!r) continue;
    if (!isStrong(r.url)) continue; // weak sites (calculators, blogs, comment links) never make the footnotes
    if (/[?&]comment/i.test(r.url)) continue;
    const n = normUrl(r.url);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ title: String(r.title || s.title || r.url).slice(0, 200), url: r.url });
  }
  return out.slice(0, 5);
}
function extractJson(text) {
  let raw = null;
  const low = text.toLowerCase();
  for (let i = low.lastIndexOf("<json>"); i >= 0; i = low.lastIndexOf("<json>", i - 1)) {
    const end = low.indexOf("</json>", i);
    if (end > i) { raw = text.slice(i + 6, end); break; }
    if (i === 0) break;
  }
  if (!raw) {
    const a = text.indexOf("{"), z = text.lastIndexOf("}");
    if (a >= 0 && z > a) raw = text.slice(a, z + 1);
  }
  if (!raw) return null;
  raw = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(raw); } catch (e) { return null; }
}
// Remove citation tags the model sometimes writes into its answers (e.g. <cite index="21-8">...</cite>), plus markdown bold.
const cleanText = s => String(s || "").replace(/<\/?cite\b[^>]*>/gi, "").replace(/<\/?(antml:)?[a-z_]+:?[a-z_]*\b[^>]*>/gi, m => /^<\/?(b|i|u|br)\b/i.test(m) ? m : "").replace(/\*\*/g, "").replace(/[ \t]{2,}/g, " ").trim();
const clip = (s, n) => cleanText(s).slice(0, n);
const okVerdict = v => (["true", "partly", "busted", "none"].includes(v) ? v : "none");

async function anthropic(messages, maxSearches, model) {
  const body = { model: model || MODEL, max_tokens: 8000, system: SYSTEM, messages };
  if (maxSearches > 0) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error("Anthropic API error " + r.status + ": " + t.slice(0, 300)); }
  return r.json();
}
async function callClaude(userPrompt, maxSearches) {
  const messages = [{ role: "user", content: userPrompt }];
  const retrieved = new Map();
  let finalText = "", lastText = "";
  const absorb = data => {
    lastText = "";
    for (const block of data.content || []) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const res of block.content) if (res && res.url) retrieved.set(normUrl(res.url), { url: res.url, title: res.title || "" });
      }
      if (block.type === "text") {
        finalText += block.text; lastText += block.text;
        for (const c of block.citations || []) if (c && c.url) retrieved.set(normUrl(c.url), { url: c.url, title: c.title || "" });
      }
    }
  };
  let data = null;
  for (let round = 0; round < 4; round++) {
    data = await anthropic(messages, maxSearches);
    absorb(data);
    if (data.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: data.content }); continue; }
    break;
  }
  // Backup step: if the research finished but the final answer is missing or was cut off, ask for just the answer.
  if (!extractJson(finalText) && data) {
    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: "Thank you. Now reply with ONLY the final <json>...</json> object in the exact shape requested, using only the pages you already found. Do not search again." });
    try { const d2 = await anthropic(messages, 1); absorb(d2); } catch (e) { console.error(e); }
  }
  return { text: finalText, retrieved };
}

const clipList = (a, n, len) => (Array.isArray(a) ? a : []).slice(0, n).map(x => clip(x, len)).filter(Boolean);

module.exports = async (req, res) => {
  if (!(await require("./_lwgate")(req, res, "the-food-hall"))) return;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const origin = req.headers.origin || "";
  if (ALLOWED.length && origin && !ALLOWED.some(a => origin === a)) {
    return res.status(403).json({ error: "This tool only works on its home website." });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "x").split(",")[0].trim();
  if (overLimit(ip, DAILY_LIMIT)) {
    return res.status(429).json({ error: "limit", message: "You've reached today's limit for new lessons. Come back tomorrow for more!" });
  }

  const b = req.body || {};
  const mode = String(b.mode || "");
  const level = b.level === "kids" ? "kids" : "grown";
  const prompt = modePrompt(mode, b, level);
  if (!prompt) return res.status(400).json({ error: "Unknown mode" });

  try {
    // Quick modes: no web search, faster model
    if (mode === "more" || mode === "recipe") {
      const data = await anthropic([{ role: "user", content: prompt }], 0, mode === "more" ? FAST_MODEL : MODEL);
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const j = extractJson(text) || {};
      if (mode === "more") return res.status(200).json({ topics: clipList(j.topics, 6, 80) });
      if (j.ok === false) return res.status(200).json({ ok: false, intro: clip(j.intro, 400) || "That one isn't something we can cook up here. Try another food!" });
      return res.status(200).json({
        ok: true, title: clip(j.title, 120), intro: clip(j.intro, 500), serves: clip(j.serves, 40), time: clip(j.time, 40),
        ingredients: clipList(j.ingredients, 20, 160), steps: clipList(j.steps, 10, 400), learn: clip(j.learn, 400),
        wiki: clip(j.wiki, 120), allergy: ALLERGY_NOTE
      });
    }

    const searches = mode === "lesson" ? 6 : mode === "compare" ? 5 : 4;
    const { text, retrieved } = await callClaude(prompt, searches);
    const j = extractJson(text) || {};
    const sources = verifySources(j.sources, retrieved);
    const touchesHealth = t => /nutri|vitamin|mineral|protein|calori|diet|health|fiber|sugar|sodium|fat\b|fats\b|carb/i.test(t);

    if (mode === "lesson") {
      if (j.ok === false) return res.status(200).json({ ok: false, intro: clip(j.intro, 400) || "The Food Hall only serves food topics. Try another one!" });
      if (!sources.length) return res.status(200).json({ ok: false, intro: NOT_CONFIRMED[level] });
      const sections = (Array.isArray(j.sections) ? j.sections : []).slice(0, 4).map(s => ({ heading: clip(s && s.heading, 80), text: clip(s && s.text, 900) })).filter(s => s.text);
      const all = [j.title, j.intro, ...sections.map(s => s.text)].join(" ");
      return res.status(200).json({
        ok: true, title: clip(j.title, 140), intro: clip(j.intro, 600), sections, wow: clip(j.wow, 400), kitchen: clip(j.kitchen, 300),
        recipeIdea: clip(j.recipeIdea, 100), wiki: clip(j.wiki, 120), followups: clipList(j.followups, 3, 140),
        health: b.stall === "nutrition" || touchesHealth(all) ? HEALTH_NOTE : "", sources
      });
    }

    if (mode === "ask") {
      if (!sources.length || j.confirmed === false) {
        return res.status(200).json({ confirmed: false, answer: j.confirmed === false && j.answer ? clip(j.answer, 900) : NOT_CONFIRMED[level], sources });
      }
      const answer = clip(j.answer, 1800);
      return res.status(200).json({ confirmed: true, answer, wiki: clip(j.wiki, 120), health: touchesHealth(answer + " " + (b.question || "")) ? HEALTH_NOTE : "", sources });
    }

    if (mode === "compare") {
      const agreement = ["matches", "partly", "differs"].includes(j.agreement) ? j.agreement : "partly";
      return res.status(200).json({ agreement, summary: clip(j.summary, 1000), differences: clipList(j.differences, 6, 400), sources });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Mr. Paul couldn't reach the kitchen just now. Please try again in a minute." });
  }
};
