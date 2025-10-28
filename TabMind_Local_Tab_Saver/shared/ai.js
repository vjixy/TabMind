
// shared/ai.js
// Thin wrappers around Chrome built-in AI (Prompt API + Summarizer API).
// IMPORTANT: These APIs are *not* available in workers. Use them from a document (popup/sidepanel).

export const AI = {
  promptSession: null,
  summarizerTLDR: null,
  summarizerKP: null,
  lastAvailability: { prompt: 'checking', summarize: 'checking' },
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) fn(this.lastAvailability); },

  async checkAvailability() {
    let prompt = 'unavailable';
    let summarize = 'unavailable';
    try {
      if ('LanguageModel' in self) {
        prompt = await LanguageModel.availability();
      }
      if ('Summarizer' in self) {
        summarize = await Summarizer.availability();
      }
    } catch (e) {
      console.warn('Availability error', e);
    }
    this.lastAvailability = { prompt, summarize };
    this.emit();
    return this.lastAvailability;
  },

  async ensurePromptSession(opts = {}) {
    if (this.promptSession) return this.promptSession;
    const availability = ('LanguageModel' in self) ? await LanguageModel.availability(opts) : 'unavailable';
    if (availability === 'unavailable') throw new Error('Prompt API unavailable. See hardware requirements and enable built-in AI.');
    // Must be triggered by user activation when downloading models.
    const session = await LanguageModel.create({
      ...opts,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          document.dispatchEvent(new CustomEvent('ai-download', { detail: { type: 'prompt', progress: e.loaded } }));
        });
      }
    });
    this.promptSession = session;
    this.lastAvailability.prompt = availability;
    this.emit();
    return session;
  },

  async ensureSummarizers() {
    // TL;DR
    const avail = ('Summarizer' in self) ? await Summarizer.availability() : 'unavailable';
    if (avail === 'unavailable') throw new Error('Summarizer API unavailable.');
    if (!this.summarizerTLDR) {
      this.summarizerTLDR = await Summarizer.create({
        type: 'tldr',
        length: 'short',
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            document.dispatchEvent(new CustomEvent('ai-download', { detail: { type: 'summarizer', progress: e.loaded } }));
          });
        }
      });
    }
    if (!this.summarizerKP) {
      this.summarizerKP = await Summarizer.create({
        type: 'key-points',
        format: 'markdown',
        length: 'short'
      });
    }
    this.lastAvailability.summarize = avail;
    this.emit();
    return { tldr: this.summarizerTLDR, kp: this.summarizerKP };
  },

  async summarize(text) {
    const { tldr, kp } = await this.ensureSummarizers();
    const tldrOut = await tldr.summarize(text);
    const kpOut = await kp.summarize(text);
    return { tldr: tldrOut, keyPoints: kpOut };
  },

  async extractTags(text) {
    const session = await this.ensurePromptSession();
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, maxItems: 8 },
        intent: { type: "string" },
        entities: { type: "array", items: { type: "string" }, maxItems: 10 }
      },
      required: ["tags"]
    };
    const prompt = `You extract concise tags, a short intent and key entities from web page text.
Rules:
- Output JSON ONLY that matches the given schema.
- Tags: max 8, single or double‑word, lower‑case, kebab-case preferred, no punctuation, no duplicates.
- Intent: short phrase of what the page helps a user do (e.g., "learn css grid", "buy laptop", "api reference").
- Entities: proper nouns like libraries, products, people, orgs.
Text:\n${text.slice(0, 8000)}`;
    const raw = await session.prompt(prompt, { responseConstraint: schema, omitResponseConstraintInput: true });
    let parsed;
    try { parsed = JSON.parse(raw); } catch(e) {
      parsed = { tags: [], intent: "", entities: [] };
    }
    // Normalize tags
    parsed.tags = (parsed.tags || []).map(t => t.toLowerCase().trim()).filter(Boolean);
    return parsed;
  },

  async rerank(query, candidates) {
    if (!candidates.length) return [];
    const session = await this.ensurePromptSession();
    const schema = {
      type: "object",
      properties: {
        ranked: {
          type: "array",
          items: { type: "object",
            properties: { id: { type: "number" }, score: { type: "number" } },
            required: ["id", "score"]
          },
          maxItems: Math.min(10, candidates.length)
        }
      },
      required: ["ranked"]
    };

    const list = candidates.map(c => ({
      id: c.id,
      title: c.title,
      url: c.url,
      tags: (c.tags || []).join(", "),
      summary: c.summary?.tldr || "",
      keyPoints: c.summary?.keyPoints || ""
    }));

    const prompt = `You are a retrieval re-ranker. Given a user query and a list of saved web pages,
return a JSON object { ranked: [{ id, score }] } sorted descending by relevance.
Consider semantic similarity to the query, exact matches on tags, and usefulness.
Query: ${query}
Items:\n${JSON.stringify(list).slice(0, 12000)}`;

    const raw = await session.prompt(prompt, { responseConstraint: schema, omitResponseConstraintInput: true });
    let out;
    try { out = JSON.parse(raw).ranked; } catch(e) { out = []; }
    const map = new Map(out.map(x => [x.id, x.score]));
    return [...candidates].sort((a,b) => (map.get(b.id)||0) - (map.get(a.id)||0));
  }
};
