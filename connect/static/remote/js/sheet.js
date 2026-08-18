// sheet.js — bottom action sheet used for per-song actions (Play, Play
// Next, Add to Queue, Start Song Radio).

export function openActionSheet(actions) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';

  function close() {
    backdrop.remove();
    sheet.remove();
  }

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.innerHTML = action.icon
      ? `<i class="mdi ${action.icon} sheet-icon"></i>${action.label}`
      : action.label;
    btn.addEventListener('click', () => {
      close();
      action.onSelect();
    });
    sheet.appendChild(btn);
  }

  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}
