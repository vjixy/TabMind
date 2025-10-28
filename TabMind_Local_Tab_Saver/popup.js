
import { openDB, addItem, getAll, lexicalFilter, DEFAULT_SEARCH_FIELDS } from './shared/db.js';
import { AI } from './shared/ai.js';

const els = {
  aiStatus: document.getElementById('aiStatus'),
  initAI: document.getElementById('initAI'),
  saveTab: document.getElementById('saveTab'),
  progress: document.getElementById('progress'),
  q: document.getElementById('q'),
  searchBtn: document.getElementById('searchBtn'),
  results: document.getElementById('results'),
  recent: document.getElementById('recent'),
  openSidePanel: document.getElementById('openSidePanel'),
  searchFilterBtn: document.getElementById('searchFilterBtn'),
  searchFilterMenu: document.getElementById('searchFilterMenu'),
};

const filterCheckboxes = Array.from(els.searchFilterMenu?.querySelectorAll('input[type="checkbox"]') ?? []);

const debouncedSearch = debounce(() => doSearch({ skipIndicator: true }), 150);

function setStatus({ prompt, summarize }) {
  const ok = (s) => s && s !== 'unavailable';
  els.aiStatus.textContent = `AI: ${ok(prompt)||ok(summarize) ? 'ready' : 'needs setup'}`;
  els.aiStatus.className = 'badge ' + (ok(prompt)||ok(summarize) ? 'ok' : 'warn');
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

    els.progress.textContent = 'Summarizing…';
    const summary = await AI.summarize(page.text);

    els.progress.textContent = 'Extracting tags…';
    const meta = await AI.extractTags(page.text);

    const item = {
      url: page.url,
      title: page.title,
      savedAt: Date.now(),
      summary,
      tags: meta.tags || [],
      intent: meta.intent || '',
      entities: meta.entities || [],
      note: page.selection || ''
    };

    await addItem(item);
    els.progress.textContent = 'Saved!';
    await refreshRecent();

  } catch (e) {
    console.error(e);
    els.progress.textContent = 'Error: ' + e.message;
  }
});

els.searchBtn.addEventListener('click', doSearch);
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
    return `<div class="card">
      <h4><a href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.title || it.url)}</a></h4>
    </div>`;
  }).join('');
}

async function refreshRecent() {
  const items = (await getAll()).sort((a,b) => b.savedAt - a.savedAt).slice(0, 1);
  renderResults(items, els.recent);
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
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
