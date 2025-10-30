
import { addItem, getAll, lexicalFilter, updateItem, DEFAULT_SEARCH_FIELDS, removeItem } from './shared/db.js';
import { AI } from './shared/ai.js';
import { captureActiveTabContent, buildAIContext, enrichSavedItem } from './shared/tabActions.js';

const els = {
  saveTab: document.getElementById('panelSaveTab'),
  exportBtn: document.getElementById('panelExport'),
  q: document.getElementById('q'),
  results: document.getElementById('results'),
  progress: document.getElementById('progress'),
  searchFilterBtn: document.getElementById('panelSearchFilterBtn'),
  searchFilterMenu: document.getElementById('panelSearchFilterMenu'),
  searchOrderBtn: document.getElementById('panelSearchOrderBtn'),
  searchOrderMenu: document.getElementById('panelSearchOrderMenu')
};

const filterCheckboxes = Array.from(els.searchFilterMenu?.querySelectorAll('input[type="checkbox"]') ?? []);
const orderRadios = Array.from(els.searchOrderMenu?.querySelectorAll('input[type="radio"]') ?? []);

const debouncedSearch = debounce(() => doSearch({ skipIndicator: true }), 150);

const SEARCH_PREF_KEY = 'tabmind_side_search_prefs';
const ORDER_OPTIONS = ['date_desc', 'date_asc', 'rating_desc', 'rating_asc'];
let selectedFields = [...DEFAULT_SEARCH_FIELDS];
let selectedOrder = 'date_desc';
let lastSearchResults = [];

function setStatus({ prompt, summarize }) {
}
AI.onChange(setStatus);
AI.checkAvailability();

document.addEventListener('ai-download', (e) => {
  const { type, progress } = e.detail;
  els.progress.textContent = `${type} model download: ${Math.round(progress*100)}%`;
});

if (els.saveTab) {
  els.saveTab.addEventListener('click', async () => {
    setPanelProgress('Reading tab…');
    try {
      const page = await captureActiveTabContent();
      const aiContext = buildAIContext(page);
      const baseItem = {
        url: page.url,
        title: page.title,
        savedAt: Date.now(),
        summary: { tldr: '', keyPoints: '' },
        tags: [],
        intent: '',
        entities: [],
        note: page.selection || '',
        rating: 0,
        enhancedAt: 0
      };

      setPanelProgress('Saving tab…');
      const savedItem = await addItem({ ...baseItem });
      setPanelProgress('Saved! Enhancing in background…');
      await doSearch({ skipIndicator: true });
      setTimeout(() => {
        if (els.progress && els.progress.textContent === 'Saved! Enhancing in background…') {
          setPanelProgress('');
        }
      }, 2000);

      enrichSavedItem(savedItem, aiContext)
        .then(async () => {
          await doSearch({ skipIndicator: true });
          const current = els.progress ? els.progress.textContent : '';
          if (current && current !== 'Saved! Enhancing in background…') return;
          setPanelProgress('Tab enriched.');
          setTimeout(() => {
            if (els.progress && els.progress.textContent === 'Tab enriched.') {
              setPanelProgress('');
            }
          }, 2000);
        })
        .catch((err) => {
          console.warn('Background enhancement failed', err);
        });
    } catch (err) {
      console.error(err);
      setPanelProgress('Error: ' + err.message);
    }
  });
}

if (els.exportBtn) {
  els.exportBtn.addEventListener('click', () => {
    if (!lastSearchResults.length) {
      const message = 'No results to export.';
      setPanelProgress(message);
      setTimeout(() => {
        if (els.progress && els.progress.textContent === message) {
          setPanelProgress('');
        }
      }, 2000);
      return;
    }

    try {
      const markdown = buildExportMarkdown(lastSearchResults);
      const filename = buildExportFilename();
      triggerMarkdownDownload(markdown, filename);
      const message = `Exported ${lastSearchResults.length} item${lastSearchResults.length === 1 ? '' : 's'}.`;
      setPanelProgress(message);
      setTimeout(() => {
        if (els.progress && els.progress.textContent === message) {
          setPanelProgress('');
        }
      }, 2000);
    } catch (err) {
      console.error('Export failed', err);
      const message = 'Error exporting results.';
      setPanelProgress(message);
      setTimeout(() => {
        if (els.progress && els.progress.textContent === message) {
          setPanelProgress('');
        }
      }, 2000);
    }
  });
}

els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
els.q.addEventListener('input', () => debouncedSearch());

async function doSearch(options = {}) {
  const { skipIndicator = false } = options;
  if (!skipIndicator) {
    els.results.innerHTML = '<small>Loading…</small>';
  }
  const q = els.q.value.trim();
  const items = await getAll();
  const fields = getSelectedFields();
  let candidates = lexicalFilter(items, q, { fields }).slice(0, 50);
  if (q && q.split(/\s+/).length > 1 && candidates.length > 1) {
    try {
      candidates = await AI.rerank(q, candidates);
    } catch (e) {
      console.warn('Rerank failed', e);
    }
  }
  candidates = orderItems(candidates);
  lastSearchResults = [...candidates];
  renderResults(candidates, els.results);
}

function renderResults(items, container) {
  if (!items.length) {
    container.innerHTML = '<small>No results. Try different keywords or save tabs from the popup.</small>';
    return;
  }
  container.innerHTML = items.map(buildCardHtml).join('');

  container.querySelectorAll('.saved-card').forEach(card => {
    const id = Number(card.dataset.id);
    const item = items.find(it => Number(it.id) === id);
    if (!item) return;

    const editBtn = card.querySelector('.edit-toggle');
    const ratingControl = card.querySelector('.rating-control');
    const deleteBtn = card.querySelector('.delete-item');
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
    if (ratingControl) {
      setupRatingControl(ratingControl, item);
    }

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
        Object.assign(item, updated);
        view.innerHTML = buildViewHtml(item);
        toggleEdit(false);
        els.progress.textContent = 'Saved changes.';
        setTimeout(() => {
          if (els.progress.textContent === 'Saved changes.') {
            els.progress.textContent = '';
          }
        }, 2000);
      } catch (err) {
        console.error('Failed to update item', err);
        els.progress.textContent = 'Error saving changes.';
      }
    });

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (typeof item.id === 'undefined') return;
        els.progress.textContent = 'Deleting…';
        try {
          await removeItem(item.id);
          card.remove();
          els.progress.textContent = 'Item deleted.';
          await doSearch({ skipIndicator: true });
          setTimeout(() => {
            if (els.progress.textContent === 'Item deleted.') {
              els.progress.textContent = '';
            }
          }, 2000);
        } catch (err) {
          console.error('Failed to delete item', err);
          els.progress.textContent = 'Error deleting item.';
        }
      });
    }
  });
}

function setPanelProgress(text = '') {
  if (!els.progress) return;
  els.progress.textContent = text;
}

function buildExportMarkdown(items = []) {
  const sections = items.map((item, index) => {
    const title = sanitizeHeading(item?.title || item?.url || `Item ${index + 1}`);
    const rating = typeof item?.rating === 'number' ? String(item.rating) : '0';
    const tags = formatTags(item?.tags);
    const summary = sanitizeBlock(item?.summary?.tldr, 'None');
    const keyPoints = sanitizeBlock(item?.summary?.keyPoints, 'None');
    return [
      `## ${title}`,
      '### Rating',
      rating,
      '### Tags',
      tags,
      '### Summary',
      summary,
      '### Keypoints',
      keyPoints,
      ''
    ].join('\n');
  });
  const body = sections.join('\n').trim();
  return body ? body + '\n' : '';
}

function buildExportFilename() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `tabmind-export-${iso}.md`;
}

function sanitizeHeading(value = '') {
  const cleaned = String(value).replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned.replace(/^#+\s*/, '').trim() || 'Untitled';
}

function sanitizeBlock(value, fallback = 'None') {
  if (value === undefined || value === null) return fallback;
  const cleaned = String(value).replace(/\r/g, '').trim();
  return cleaned || fallback;
}

function formatTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return 'None';
  const cleaned = tags.map((tag) => String(tag || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(', ') : 'None';
}

function triggerMarkdownDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

function buildCardHtml(item) {
  const safeUrl = escapeHtml(item.url || '');
  return `<div class="card saved-card" data-id="${item.id}" style="margin-bottom:10px;">
    <div class="card-header">
      <div class="card-title-group">
        <h4><a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(item.title || item.url)}</a></h4>
        ${ratingControlHtml(item.rating)}
      </div>
      <div class="card-actions">
        <button type="button" class="icon-button delete-item" aria-label="Delete">
          <span class="trash-icon" aria-hidden="true"></span>
          <span class="sr-only">Delete</span>
        </button>
        <button type="button" class="icon-button edit-toggle" aria-label="Edit">
          &#9998;
        </button>
      </div>
    </div>
    <div class="view-mode">
      ${buildViewHtml(item)}
    </div>
    <form class="edit-mode hidden">
      ${buildEditFormHtml(item)}
    </form>
  </div>`;
}

function buildViewHtml(item) {
  const tagHtml = (item.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const summary = (item.summary?.tldr || '').trim();
  const keyPoints = (item.summary?.keyPoints || '').trim();
  const summaryHtml = summary ? `<p style="margin-top:6px;">${escapeHtml(summary)}</p>` : '';
  const keyPointsHtml = keyPoints
    ? `<details style="margin-top:6px;">
        <summary>Key points</summary>
        <div style="margin-top:6px;"><pre>${escapeHtml(keyPoints)}</pre></div>
      </details>`
    : '';

  const parts = [];
  if (tagHtml) parts.push(`<div>${tagHtml}</div>`);
  if (summaryHtml) parts.push(summaryHtml);
  if (keyPointsHtml) parts.push(keyPointsHtml);
  parts.push(`<small>${new Date(item.savedAt).toLocaleString()}</small>`);
  return parts.join('');
}

function buildEditFormHtml(item) {
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

function setupRatingControl(control, item) {
  if (!control) return;
  const stars = Array.from(control.querySelectorAll('.rating-star'));
  const applyDisplay = (value) => updateRatingDisplay(control, value);
  applyDisplay(item.rating ?? 0);

  let saving = false;
  const saveRating = async (value) => {
    const next = clampRating(value);
    if (Math.abs((item.rating ?? 0) - next) < 0.001) {
      applyDisplay(next);
      return;
    }
    if (saving) return;
    saving = true;
    els.progress.textContent = 'Saving rating…';
    const updated = { ...item, rating: next };
    try {
      await updateItem(updated);
      Object.assign(item, updated);
      applyDisplay(next);
      els.progress.textContent = 'Rating saved.';
      setTimeout(() => {
        if (els.progress.textContent === 'Rating saved.') {
          els.progress.textContent = '';
        }
      }, 2000);
    } catch (err) {
      console.error('Failed to save rating', err);
      els.progress.textContent = 'Error saving rating.';
    } finally {
      saving = false;
    }
  };

  control.addEventListener('click', (event) => {
    const star = event.target.closest('.rating-star');
    if (!star) return;
    const rect = star.getBoundingClientRect();
    const usingKeyboard = event.detail === 0 || (event.clientX === 0 && event.clientY === 0);
    const offset = event.clientX - rect.left;
    const half = usingKeyboard ? 1 : (offset <= rect.width / 2 ? 0.5 : 1);
    const index = Number(star.dataset.index) || 0;
    const newRating = clampRating(index + half);
    saveRating(newRating);
  });

  control.addEventListener('keydown', (event) => {
    let delta = 0;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      delta = 0.5;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      delta = -0.5;
    } else if (event.key === 'Home') {
      event.preventDefault();
      saveRating(0);
      return;
    } else if (event.key === 'End') {
      event.preventDefault();
      saveRating(5);
      return;
    } else {
      return;
    }
    event.preventDefault();
    const current = Number(control.dataset.value) || 0;
    const newRating = clampRating(current + delta);
    saveRating(newRating);
  });
}

function updateRatingDisplay(control, value) {
  const val = clampRating(typeof value === 'number' ? value : 0);
  control.dataset.value = String(val);
  control.setAttribute('aria-valuenow', String(val));
  control.setAttribute('aria-valuetext', val ? `${val} out of 5` : 'Not rated');
  control.setAttribute('title', val ? `${val.toFixed(1)} / 5` : 'Not rated');
  const stars = Array.from(control.querySelectorAll('.rating-star'));
  stars.forEach((star, index) => {
    const fill = Math.max(0, Math.min(1, val - index));
    star.classList.remove('full', 'half', 'empty');
    if (fill >= 1) {
      star.classList.add('full');
    } else if (fill >= 0.5) {
      star.classList.add('half');
    } else {
      star.classList.add('empty');
    }
    star.setAttribute('aria-pressed', fill > 0 ? 'true' : 'false');
  });
}

function clampRating(value = 0) {
  const rounded = Math.round(Math.max(0, Math.min(5, value)) * 2) / 2;
  return rounded;
}

function ratingControlHtml(value = 0) {
  const val = clampRating(typeof value === 'number' ? value : 0);
  const stars = Array.from({ length: 5 }, (_, idx) => {
    return `<button type="button" class="rating-star empty" data-index="${idx}" aria-label="Rate ${idx + 1} star${idx === 0 ? '' : 's'}"></button>`;
  }).join('');
  return `<div class="rating-control" role="slider" aria-label="Rating" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${val}" tabindex="0" data-value="${val}">
    ${stars}
  </div>`;
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

  entries.forEach(entry => {
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
    // ignore
  }
}

initialize();

async function initialize() {
  await loadSearchPreferences();
  setupSearchControls();
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
