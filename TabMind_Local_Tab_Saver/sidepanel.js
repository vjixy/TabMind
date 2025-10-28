
import { getAll, lexicalFilter, updateItem } from './shared/db.js';
import { AI } from './shared/ai.js';

const els = {
  aiStatus: document.getElementById('aiStatus'),
  q: document.getElementById('q'),
  searchBtn: document.getElementById('searchBtn'),
  results: document.getElementById('results'),
  progress: document.getElementById('progress'),
  refreshBtn: document.getElementById('refreshBtn')
};

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

els.refreshBtn.addEventListener('click', () => doSearch());
els.searchBtn.addEventListener('click', () => doSearch());
els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  els.results.innerHTML = '<small>Loading…</small>';
  const q = els.q.value.trim();
  const items = await getAll();
  let candidates = lexicalFilter(items, q).slice(0, 50);
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
  });
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

function buildCardHtml(item) {
  const safeUrl = escapeHtml(item.url || '');
  return `<div class="card saved-card" data-id="${item.id}" style="margin-bottom:10px;">
    <div class="card-header">
      <h4><a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(item.title || item.url)}</a></h4>
      <button type="button" class="icon-button edit-toggle" aria-label="Edit">&#9998;</button>
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

function parseTags(value='') {
  return value.split(',').map(t => t.trim()).filter(Boolean);
}

doSearch();
