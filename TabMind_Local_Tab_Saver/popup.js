
import { addItem, getAll, lexicalFilter, DEFAULT_SEARCH_FIELDS, updateItem } from './shared/db.js';
import { AI } from './shared/ai.js';

const els = {
  aiStatus: document.getElementById('aiStatus'),
  initAI: document.getElementById('initAI'),
  saveTab: document.getElementById('saveTab'),
  progress: document.getElementById('progress'),
  initSection: document.getElementById('initSection'),
  q: document.getElementById('q'),
  results: document.getElementById('results'),
  recent: document.getElementById('recent'),
  openSidePanel: document.getElementById('openSidePanel'),
  searchFilterBtn: document.getElementById('searchFilterBtn'),
  searchFilterMenu: document.getElementById('searchFilterMenu'),
  searchOrderBtn: document.getElementById('searchOrderBtn'),
  searchOrderMenu: document.getElementById('searchOrderMenu'),
  downloadNote: document.getElementById('downloadNote'),
};

const filterCheckboxes = Array.from(els.searchFilterMenu?.querySelectorAll('input[type="checkbox"]') ?? []);
const orderRadios = Array.from(els.searchOrderMenu?.querySelectorAll('input[type="radio"]') ?? []);

const debouncedSearch = debounce(() => doSearch({ skipIndicator: true }), 150);

const SEARCH_PREF_KEY = 'tabmind_popup_search_prefs';
const ORDER_OPTIONS = ['date_desc', 'date_asc', 'rating_desc', 'rating_asc'];
let selectedFields = [...DEFAULT_SEARCH_FIELDS];
let selectedOrder = 'date_desc';

function setStatus({ prompt, summarize }) {
  const ok = (s) => s && s !== 'unavailable';
  const ready = ok(prompt) || ok(summarize);
  els.aiStatus.textContent = `AI: ${ready ? 'ready' : 'needs setup'}`;
  els.aiStatus.className = 'badge ' + (ready ? 'ok' : 'warn');
  els.aiStatus.classList.toggle('hidden', ready);
  if (els.initAI) {
    els.initAI.classList.toggle('hidden', ready);
    els.initAI.disabled = ready;
  }
  if (els.downloadNote) {
    els.downloadNote.classList.toggle('hidden', ready);
  }
  updateInitSectionVisibility();
}

AI.onChange(setStatus);
AI.checkAvailability();

document.addEventListener('ai-download', (e) => {
  const { type, progress } = e.detail;
  setProgress(`${type} model download: ${Math.round(progress*100)}%`);
});

els.initAI.addEventListener('click', async () => {
  setProgress('Initializing models…');
  try {
    // User activation ensures download is permitted.
    await AI.ensureSummarizers();
    await AI.ensurePromptSession();
    setProgress('Models ready.');
    if (els.initAI) {
      els.initAI.classList.add('hidden');
      els.initAI.disabled = true;
    }
    if (els.downloadNote) {
      els.downloadNote.classList.add('hidden');
    }
  } catch (e) {
    setProgress('Error: ' + e.message);
  }
});

els.openSidePanel.addEventListener('click', async () => {
  // Open the side panel for this tab
  try {
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
    window.close();
  } catch(e) {
    console.warn(e);
    setProgress('Could not open side panel.');
  }
});

els.saveTab.addEventListener('click', async () => {
  setProgress('Reading tab…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');

    // Inject content script to get text
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        function getMeta(name) {
          const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
          return el?.content || "";
        }
        const title = document.title || "";
        const description = getMeta("description") || getMeta("og:description") || "";
        const keywords = getMeta("keywords") || "";
        const selection = window.getSelection()?.toString() || "";
        const raw = document.body?.innerText || "";
        const text = (title + "\n\n" + description + "\n\n" + raw).slice(0, 120_000);
        return { title, description, keywords, selection, url: location.href, text };
      }
    });

    const page = res?.result;
    if (!page) throw new Error('Could not extract page content.');

    const aiContext = buildAIContext(page);
    setProgress('Summarizing…');
    let summary = { tldr: '', keyPoints: '' };
    try {
      summary = await summarizeWithRetries(aiContext, (limit) => {
        setProgress(`Summarizing… (trimmed to ${(limit/1000).toFixed(0)}k chars)`);
      });
    } catch (err) {
      console.warn('Summarize failed, continuing with trimmed context.', err);
      summary = { tldr: '', keyPoints: '' };
    }

    setProgress('Extracting tags…');
    let meta = { tags: [], intent: '', entities: [] };
    try {
      meta = await AI.extractTags(trimContext(aiContext, 8000));
    } catch (err) {
      console.warn('Tag extraction failed.', err);
    }

    const item = {
      url: page.url,
      title: page.title,
      savedAt: Date.now(),
      summary,
      tags: meta.tags || [],
      intent: meta.intent || '',
      entities: meta.entities || [],
      note: page.selection || '',
      rating: 0
    };

    await addItem(item);
    setProgress('Saved!');
    await refreshRecent();

  } catch (e) {
    console.error(e);
    setProgress('Error: ' + e.message);
  }
});

els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
els.q.addEventListener('input', () => debouncedSearch());

async function doSearch(options = {}) {
  const { skipIndicator = false } = options;
  const q = els.q.value.trim();
  if (!skipIndicator) {
    els.results.innerHTML = '<small>Searching…</small>';
  }
  const items = await getAll();
  const fields = getSelectedFields();
  // Lexical prefilter to keep prompt context smaller
  let candidates = lexicalFilter(items, q, { fields }).slice(0, 25);
  // If the user typed a natural language query (space present), try rerank
  if (q && q.split(/\s+/).length > 1 && candidates.length > 1) {
    try {
      candidates = await AI.rerank(q, candidates);
    } catch (e) {
      console.warn('Rerank failed, fallback to lexical only.', e);
    }
  }
  candidates = orderItems(candidates);
  renderResults(candidates, els.results);
}

function renderResults(items, container) {
  if (!items.length) {
    container.innerHTML = '<small>No matches yet.</small>';
    return;
  }
  container.innerHTML = items.slice(0, 3).map(it => {
    const safeUrl = escapeHtml(it.url || '');
    const label = escapeHtml(truncate(it.title || it.url, 50));
    return `<div class="card">
      <h4><a href="${safeUrl}" target="_blank" rel="noopener">${label}</a></h4>
    </div>`;
  }).join('');
}

async function refreshRecent() {
  const items = (await getAll()).sort((a,b) => b.savedAt - a.savedAt).slice(0, 1);
  if (items.length) {
    renderRecentItem(items[0]);
  } else {
    renderRecentItem(null);
  }
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

function renderRecentItem(item) {
  if (!item) {
    els.recent.innerHTML = '<small>No saves yet.</small>';
    return;
  }

  els.recent.innerHTML = buildRecentCardHtml(item);
  const card = els.recent.querySelector('.recent-card');
  if (!card) return;

  const editBtn = card.querySelector('.edit-toggle');
  const view = card.querySelector('.view-mode');
  const form = card.querySelector('.edit-mode');
  const cancelBtn = card.querySelector('.cancel-edit');
  const tagsInput = form.querySelector('.edit-tags');
  const descInput = form.querySelector('.edit-description');
  const keypointsInput = form.querySelector('.edit-keypoints');

  const resetForm = () => {
    tagsInput.value = (item.tags || []).join(', ');
    descInput.value = item.summary?.tldr || '';
    keypointsInput.value = item.summary?.keyPoints || '';
  };

  const toggleEdit = (show) => {
    view.classList.toggle('hidden', show);
    form.classList.toggle('hidden', !show);
    card.classList.toggle('editing', show);
    if (show) resetForm();
  };

  editBtn.addEventListener('click', () => {
    const shouldShow = form.classList.contains('hidden');
    toggleEdit(shouldShow);
  });

  cancelBtn.addEventListener('click', () => toggleEdit(false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newTags = parseTags(tagsInput.value);
    const newDesc = descInput.value.trim();
    const newKeyPoints = keypointsInput.value;

    const updated = {
      ...item,
      tags: newTags,
      summary: {
        ...(item.summary || {}),
        tldr: newDesc,
        keyPoints: newKeyPoints
      }
    };

    try {
      setProgress('Saving changes…');
      await updateItem(updated);
      setProgress('Recent item updated.');
      renderRecentItem(updated);
      doSearch({ skipIndicator: true });
      setTimeout(() => {
        if (els.progress && els.progress.textContent === 'Recent item updated.') {
          setProgress('');
        }
      }, 2000);
    } catch (err) {
      console.error('Failed to update item', err);
      setProgress('Error saving changes.');
    }
  });
}

function buildRecentCardHtml(item) {
  const safeUrl = escapeHtml(item.url || '');
  const title = escapeHtml(truncate(item.title || item.url || 'Recent save', 60));
  return `<div class="card recent-card">
    <div class="card-header">
      <h4 style="margin-bottom:0;"><a href="${safeUrl}" target="_blank" rel="noopener">${title}</a></h4>
      <button type="button" class="icon-button edit-toggle" aria-label="Edit recent item">&#9998;</button>
    </div>
    <div class="view-mode">
      ${buildRecentViewHtml(item)}
    </div>
    <form class="edit-mode hidden">
      ${buildRecentEditFormHtml(item)}
    </form>
  </div>`;
}

function buildRecentViewHtml(item) {
  const tags = (item.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const summary = (item.summary?.tldr || '').trim();
  const keyPoints = (item.summary?.keyPoints || '').trim();

  const tagsSection = tags
    ? `<div style="margin-bottom:6px;">${tags}</div>`
    : '<div><small>No tags yet.</small></div>';
  const summarySection = summary
    ? `<div style="margin-top:6px;"><p style="margin:0;">${escapeHtml(summary)}</p></div>`
    : '<div style="margin-top:6px;"><small>No description yet.</small></div>';
  const keyPointsSection = keyPoints
    ? `<details style="margin-top:6px;">
        <summary>Key points</summary>
        <div style="margin-top:6px;"><pre>${escapeHtml(keyPoints)}</pre></div>
      </details>`
    : '<div style="margin-top:6px;"><small>No key points yet.</small></div>';

  return `${tagsSection}${summarySection}${keyPointsSection}`;
}

function buildRecentEditFormHtml(item) {
  const tagValue = escapeHtml((item.tags || []).join(', '));
  const descValue = escapeHtml(item.summary?.tldr || '');
  const keyPointsValue = escapeHtml(item.summary?.keyPoints || '');

  return `
    <label class="field-label">
      <span>Tags (comma separated)</span>
      <input type="text" class="edit-tags" value="${tagValue}" />
    </label>
    <label class="field-label">
      <span>Description</span>
      <textarea class="edit-description" rows="3">${descValue}</textarea>
    </label>
    <label class="field-label">
      <span>Key points</span>
      <textarea class="edit-keypoints" rows="4">${keyPointsValue}</textarea>
    </label>
    <div class="row form-actions">
      <button type="submit" class="primary save-edit">Save</button>
      <button type="button" class="ghost cancel-edit">Cancel</button>
    </div>
  `;
}

function parseTags(value='') {
  return value.split(',').map(t => t.trim()).filter(Boolean);
}

function setupSearchControls() {
  const entries = [
    els.searchFilterBtn && els.searchFilterMenu ? { button: els.searchFilterBtn, menu: els.searchFilterMenu } : null,
    els.searchOrderBtn && els.searchOrderMenu ? { button: els.searchOrderBtn, menu: els.searchOrderMenu } : null
  ].filter(Boolean);

  if (!entries.length) return;

  const hideMenu = (entry) => {
    if (!entry || entry.menu.classList.contains('hidden')) return;
    entry.menu.classList.add('hidden');
    entry.button.setAttribute('aria-expanded', 'false');
  };

  const hideAllMenus = () => entries.forEach(hideMenu);

  entries.forEach((entry) => {
    entry.button.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = entry.menu.classList.contains('hidden');
      hideAllMenus();
      if (willShow) {
        entry.menu.classList.remove('hidden');
        entry.button.setAttribute('aria-expanded', 'true');
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (entries.some(entry => entry.menu.contains(e.target))) return;
    if (entries.some(entry => entry.button.contains(e.target))) return;
    hideAllMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideAllMenus();
  });

  filterCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const active = filterCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
      if (!active.length) {
        checkbox.checked = true;
        return;
      }
      selectedFields = normalizeFields(active);
      persistSearchPreferences();
      debouncedSearch();
    });
  });

  orderRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      selectedOrder = ORDER_OPTIONS.includes(radio.value) ? radio.value : 'date_desc';
      persistSearchPreferences();
      hideAllMenus();
      doSearch({ skipIndicator: true });
    });
  });
}

function getSelectedFields() {
  return selectedFields.length ? selectedFields : [...DEFAULT_SEARCH_FIELDS];
}

function orderItems(items = []) {
  const data = [...items];
  switch (selectedOrder) {
    case 'rating_desc':
      return data.sort((a, b) => {
        const diff = (b.rating ?? 0) - (a.rating ?? 0);
        if (Math.abs(diff) > 1e-6) return diff;
        return (b.savedAt || 0) - (a.savedAt || 0);
      });
    case 'rating_asc':
      return data.sort((a, b) => {
        const diff = (a.rating ?? 0) - (b.rating ?? 0);
        if (Math.abs(diff) > 1e-6) return diff;
        return (b.savedAt || 0) - (a.savedAt || 0);
      });
    case 'date_asc':
      return data.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    case 'date_desc':
    default:
      return data.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }
}

async function loadSearchPreferences() {
  const stored = await readFromStorage(SEARCH_PREF_KEY);
  if (Array.isArray(stored?.fields) && stored.fields.length) {
    selectedFields = normalizeFields(stored.fields);
  }
  if (ORDER_OPTIONS.includes(stored?.order)) {
    selectedOrder = stored.order;
  }
  applySearchPreferencesToUI();
}

function applySearchPreferencesToUI() {
  if (filterCheckboxes.length) {
    const fieldSet = new Set(normalizeFields(selectedFields));
    filterCheckboxes.forEach(cb => {
      cb.checked = fieldSet.has(cb.value);
    });
    if (!filterCheckboxes.some(cb => cb.checked)) {
      selectedFields = [...DEFAULT_SEARCH_FIELDS];
      filterCheckboxes.forEach(cb => {
        cb.checked = selectedFields.includes(cb.value);
      });
    } else {
      selectedFields = filterCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
    }
  }
  if (orderRadios.length) {
    let matched = false;
    orderRadios.forEach(radio => {
      const shouldCheck = radio.value === selectedOrder;
      radio.checked = shouldCheck;
      if (shouldCheck) matched = true;
    });
    if (!matched) {
      selectedOrder = 'date_desc';
      orderRadios.forEach(radio => {
        radio.checked = radio.value === selectedOrder;
      });
    }
  }
}

function normalizeFields(fields = []) {
  const allowed = new Set(['title', 'tags', 'description']);
  const cleaned = fields.map(f => f.toLowerCase()).filter(f => allowed.has(f));
  return cleaned.length ? cleaned : [...DEFAULT_SEARCH_FIELDS];
}

function persistSearchPreferences() {
  saveSearchPreferences().catch((err) => console.warn('Failed to save search preferences', err));
}

async function saveSearchPreferences() {
  const payload = {
    fields: getSelectedFields(),
    order: ORDER_OPTIONS.includes(selectedOrder) ? selectedOrder : 'date_desc'
  };
  await writeToStorage(SEARCH_PREF_KEY, payload);
}

async function readFromStorage(key) {
  try {
    if (chrome?.storage?.local?.get) {
      const data = await chrome.storage.local.get(key);
      if (data && typeof data[key] !== 'undefined') {
        return data[key];
      }
    }
  } catch (err) {
    console.warn('Storage read failed', err);
  }
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

async function writeToStorage(key, value) {
  try {
    if (chrome?.storage?.local?.set) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
  } catch (err) {
    console.warn('Storage write failed', err);
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Ignore localStorage errors
  }
}

initialize();

async function initialize() {
  await loadSearchPreferences();
  setupSearchControls();
  updateInitSectionVisibility();
  await refreshRecent();
  await doSearch({ skipIndicator: true });
  persistSearchPreferences();
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), delay);
  };
}

function setProgress(text='') {
  if (!els.progress) return;
  els.progress.textContent = text || '';
  updateInitSectionVisibility();
}

function updateInitSectionVisibility() {
  const section = els.initSection;
  if (!section) return;
  const showInit = els.initAI && !els.initAI.classList.contains('hidden');
  const showNote = els.downloadNote && !els.downloadNote.classList.contains('hidden');
  const showProgress = !!(els.progress && els.progress.textContent.trim());
  const shouldShow = showInit || showNote || showProgress;
  section.classList.toggle('hidden', !shouldShow);
}

function buildAIContext(page) {
  const parts = [];
  if (page.title) parts.push(sanitizeWhitespace(page.title));
  if (page.description) parts.push(`Description:\n${sanitizeWhitespace(page.description)}`);
  if (page.keywords) parts.push(`Keywords: ${sanitizeWhitespace(page.keywords)}`);
  if (page.selection) parts.push(`User selection:\n${sanitizeWhitespace(page.selection)}`);
  if (page.text) parts.push(sanitizeWhitespace(page.text));
  return parts.join('\n\n').trim();
}

async function summarizeWithRetries(text, onTrim) {
  const sequence = [60000, 45000, 32000, 22000, 16000, 11000, 8000, 6000];
  const unique = [];
  for (const limit of sequence) {
    const len = Math.min(limit, text.length);
    if (!unique.includes(len)) unique.push(len);
  }
  let lastError;
  for (const limit of unique) {
    const snippet = trimContext(text, limit);
    if (snippet.length < text.length && onTrim) {
      onTrim(limit);
    }
    try {
      return await AI.summarize(snippet);
    } catch (err) {
      if (!isTooLargeError(err)) throw err;
      lastError = err;
      text = snippet;
    }
  }
  if (lastError) throw lastError;
  return await AI.summarize(trimContext(text, 6000));
}

function trimContext(text, limit) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastBreak = slice.lastIndexOf('\n');
  if (lastBreak > limit * 0.6) {
    return slice.slice(0, lastBreak);
  }
  return slice;
}

function sanitizeWhitespace(value='') {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTooLargeError(err) {
  const msg = (err && (err.message || err.toString())) || '';
  return /too\s+large|exceeds|length|token/i.test(msg);
}

function truncate(str = '', max = 50) {
  if (str.length <= max) return str;
  return str.slice(0, max).trimEnd() + '...';
}
