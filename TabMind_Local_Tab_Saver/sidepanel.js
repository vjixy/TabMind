
import { getAll, lexicalFilter } from './shared/db.js';
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
  container.innerHTML = items.map(it => {
    const tagHtml = (it.tags||[]).map(t => `<span class="tag">${t}</span>`).join('');
    return `<div class="card" style="margin-bottom:10px;">
      <h4><a href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.title || it.url)}</a></h4>
      <div>${tagHtml}</div>
      <p style="margin-top:6px;">${escapeHtml(it.summary?.tldr || '')}</p>
      <details style="margin-top:6px;">
        <summary>Key points</summary>
        <div style="margin-top:6px;"><pre>${escapeHtml(it.summary?.keyPoints || '')}</pre></div>
      </details>
      <small>${new Date(it.savedAt).toLocaleString()}</small>
    </div>`;
  }).join('');
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

doSearch();
