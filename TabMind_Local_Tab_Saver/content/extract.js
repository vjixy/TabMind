
(() => {
  // Extract a concise but rich text snapshot of the page.
  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el?.content || "";
  }

  const title = document.title || "";
  const description = getMeta("description") || getMeta("og:description") || "";
  const keywords = getMeta("keywords") || "";
  const selection = window.getSelection()?.toString() || "";

  // Use innerText to get rendered text (better signal than textContent).
  // Clamp to avoid huge payloads; the model does better with a curated sample.
  const raw = document.body?.innerText || "";
  const text = (title + "\n\n" + description + "\n\n" + raw).slice(0, 120_000);

  return {
    title,
    description,
    keywords,
    selection,
    url: location.href,
    text
  };
})();
