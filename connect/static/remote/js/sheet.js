// sheet.js — bottom action sheet used for per-song actions (Play, Play
// Next, Add to Queue, Start Song Radio).
//
// Each action's onSelect() is treated as awaitable — sendCommand() (api.js)
// now blocks on connect's /remote/command until the renderer has actually
// applied it, instead of resolving as soon as it's sent. Without waiting
// here too, the sheet would close (and the tapped icon go back to normal)
// before the command had actually landed, which is exactly the "did my tap
// register?" ambiguity that blocking send was meant to fix in the first
// place — a user unsure whether a tap took effect has every reason to tap
// again, doubling up a queue-add.

export function openActionSheet(actions) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';

  function close() {
    backdrop.remove();
    sheet.remove();
  }

  // Only one action can be in flight at a time — every button (not just the
  // tapped one) is disabled for the duration, both to stop a second action
  // firing before the first has landed and because the sheet has only one
  // outcome (close) to show once something succeeds.
  let pending = false;

  for (const action of actions) {
    const btn = document.createElement('button');
    const icon = action.icon ? document.createElement('i') : null;
    if (icon) {
      icon.className = `mdi ${action.icon} sheet-icon`;
      btn.appendChild(icon);
    }
    btn.appendChild(document.createTextNode(action.label));

    btn.addEventListener('click', () => {
      if (pending) return;
      pending = true;
      if (icon) icon.className = 'mdi mdi-loading mdi-spin sheet-icon';
      for (const b of sheet.querySelectorAll('button')) b.disabled = true;

      Promise.resolve(action.onSelect()).then(close, (error) => {
        console.error('[remote] Action failed:', error);
        pending = false;
        if (icon) icon.className = `mdi ${action.icon} sheet-icon`;
        for (const b of sheet.querySelectorAll('button')) b.disabled = false;
      });
    });
    sheet.appendChild(btn);
  }

  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}
