export function esc(s: string | number): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html) e.innerHTML = html;
  return e;
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Show a modal over the current screen. Returns a function that closes it. */
export function modal(html: string, onClick?: (target: HTMLElement, close: () => void) => void, className = ''): () => void {
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', `modal ${className}`, html);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === backdrop) return close();
    const action = t.closest<HTMLElement>('[data-action]');
    if (action?.dataset.action === 'close') return close();
    if (onClick && action) onClick(action, close);
  });
  return close;
}

export function toast(text: string): void {
  const t = el('div', 'toast', esc(text));
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

/** In-page yes/no dialog (native confirm() is blocked in some embedded web views). */
export function confirmDialog(text: string, yesLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    modal(
      `<p class="confirm-text">${esc(text)}</p>
       <div class="confirm-actions">
         <button class="btn ghost" data-action="no">Cancel</button>
         <button class="btn danger" data-action="yes">${esc(yesLabel)}</button>
       </div>`,
      (target, done) => {
        done();
        resolve(target.dataset.action === 'yes');
      },
      'confirm',
    );
    // Tapping outside the dialog dismisses it, which counts as "no".
    document.querySelector('.modal-backdrop:last-child')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) resolve(false);
    });
  });
}
