'use strict';

for (const button of document.querySelectorAll('[data-copy]')) {
  const code = document.getElementById(button.dataset.copy);
  if (!code) continue;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      document.getElementById('copy-status').textContent = `Copied: ${button.getAttribute('aria-label')}. Paste it into the indicated session.`;
    } catch {
      const selection = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(code);
      selection.removeAllRanges(); selection.addRange(range);
      document.getElementById('copy-status').textContent = 'Clipboard unavailable. The text is selected; press Command+C or Ctrl+C.';
    }
  });
}
