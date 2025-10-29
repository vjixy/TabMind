
import { addItem, getAll, lexicalFilter, DEFAULT_SEARCH_FIELDS, updateItem } from './shared/db.js';
import { AI } from './shared/ai.js';

const els = {
  aiStatus: document.getElementById('aiStatus'),
  initAI: document.getElementById('initAI'),
  saveTab: document.getElementById('saveTab'),
  progress: document.getElementById('progress'),
  q: document.getElementById('q'),
  results: document.getElementById('results'),
  recent: document.getElementById('recent'),
  openSidePanel: document.getElementById('openSidePanel'),
  searchFilterBtn: document.getElementById('searchFilterBtn'),
  searchFilterMenu: document.getElementById('searchFilterMenu'),
  downloadNote: document.getElementById('downloadNote'),
};

const filterCheckboxes = Array.from(els.searchFilterMenu?.querySelectorAll('input[type="checkbox"]') ?? []);

const debouncedSearch = debounce(() => doSearch({ skipIndicator: true }), 150);

function setStatus({ prompt, summarize }) {
  const ok = (s) => s && s !== 'unavailable';
  const ready = ok(prompt) || ok(summarize);
  els.aiStatus.textContent = `AI: ${ready ? 'ready' : 'needs setup'}`;
  els.aiStatus.className = 'badge ' + (ready ? 'ok' : 'warn');
  if (els.initAI) {
    els.initAI.classList.toggle('hidden', ready);
    els.initAI.disabled = ready;
  }
  if (els.downloadNote) {
    els.downloadNote.classList.toggle('hidden', ready);
  }
}

AI.onChange(setStatus);
AI.checkAvailability();

document.addEventListener('ai-download', (e) => {
  const { type, progress } = e.detail;
  els.progress.textContent = `${type} model download: ${Math.round(progress*100)}%`;
});

els.initAI.addEventListener('click', async () => {
  els.progress.textContent = 'Initializing models…';
  try {
    // User activation ensures download is permitted.
    await AI.ensureSummarizers();
    await AI.ensurePromptSession();
    els.progress.textContent = 'Models ready.';
    if (els.initAI) {
      els.initAI.classList.add('hidden');
      els.initAI.disabled = true;
    }
    if (els.downloadNote) {
      els.downloadNote.classList.add('hidden');
    }
  } catch (e) {
    els.progress.textContent = 'Error: ' + e.message;
  }
});

els.openSidePanel.addEventListener('click', async () => {
  // Open the side panel for this tab
  try {
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
    window.close();
  } catch(e) {
    console.warn(e);
    els.progress.textContent = 'Could not open side panel.';
  }
});

els.saveTab.addEventListener('click', async () => {
  els.progress.textContent = 'Reading tab…';
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
    els.progress.textContent = 'Summarizing…';
    let summary = { tldr: '', keyPoints: '' };
    try {
      summary = await summarizeWithRetries(aiContext, (limit) => {
        els.progress.textContent = `Summarizing… (trimmed to ${(limit/1000).toFixed(0)}k chars)`;
      });
    } catch (err) {
      console.warn('Summarize failed, continuing with trimmed context.', err);
      summary = { tldr: '', keyPoints: '' };
    }

    els.progress.textContent = 'Extracting tags…';
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
    els.progress.textContent = 'Saved!';
    await refreshRecent();

  } catch (e) {
    console.error(e);
    els.progress.textContent = 'Error: ' + e.message;
  }
});

els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
els.q.addEventListener('input', () => debouncedSearch());

setupFilterControls();

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
  renderResults(candidates, els.results);
}

function renderResults(items, container) {
  if (!items.length) {
    container.innerHTML = '<small>No matches yet.</small>';
    return;
  }
  container.innerHTML = items.slice(0, 10).map(it => {
    const safeUrl = escapeHtml(it.url || '');
    const label = escapeHtml(it.title || it.url);
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
      els.progress.textContent = 'Saving changes…';
      await updateItem(updated);
      els.progress.textContent = 'Recent item updated.';
      renderRecentItem(updated);
      doSearch({ skipIndicator: true });
      setTimeout(() => {
        if (els.progress.textContent === 'Recent item updated.') {
          els.progress.textContent = '';
        }
      }, 2000);
    } catch (err) {
      console.error('Failed to update item', err);
      els.progress.textContent = 'Error saving changes.';
    }
  });
}

function buildRecentCardHtml(item) {
  return `<div class="card recent-card">
    <div class="card-header">
      <h4 style="margin-bottom:0;">Most Recent Save</h4>
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

function setupFilterControls() {
  if (!els.searchFilterBtn || !els.searchFilterMenu) return;
  const menu = els.searchFilterMenu;

  const hideMenu = () => {
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    els.searchFilterBtn.setAttribute('aria-expanded', 'false');
  };

  const toggleMenu = () => {
    const willShow = menu.classList.contains('hidden');
    if (willShow) {
      menu.classList.remove('hidden');
      els.searchFilterBtn.setAttribute('aria-expanded', 'true');
    } else {
      hideMenu();
    }
  };

  els.searchFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !els.searchFilterBtn.contains(e.target)) {
      hideMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });

  filterCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const active = getSelectedFields();
      if (!active.length) {
        checkbox.checked = true;
        return;
      }
      debouncedSearch();
    });
  });
}

function getSelectedFields() {
  const active = filterCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
  return active.length ? active : DEFAULT_SEARCH_FIELDS;
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), delay);
  };
}

refreshRecent();
doSearch({ skipIndicator: true });

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
