
import { getAll, lexicalFilter, updateItem, DEFAULT_SEARCH_FIELDS, removeItem } from './shared/db.js';
import { AI } from './shared/ai.js';

const els = {
  aiStatus: document.getElementById('aiStatus'),
  q: document.getElementById('q'),
  results: document.getElementById('results'),
  progress: document.getElementById('progress'),
  searchFilterBtn: document.getElementById('panelSearchFilterBtn'),
  searchFilterMenu: document.getElementById('panelSearchFilterMenu')
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

els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
els.q.addEventListener('input', () => debouncedSearch());

setupFilterControls();

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

doSearch({ skipIndicator: true });
