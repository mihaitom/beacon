// party.js — the party, from the phone: whether it runs, the invitation
// link and who came, with starting, renewing, taking over and ending it.
// The app's own phone page is MobilePartyView.vue; the rules and the QR
// poster stay on the device that hosts the party.

import { fetchParty, sendReportedCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { n, t } from '../i18n.js';

export function renderParty(root) {
  root.innerHTML = `
    <div class="view-head">
      <h1 class="view-title">${t('party.title')}</h1>
      <button type="button" class="row-action" id="party-refresh"
              title="${t('common.retry')}" aria-label="${t('common.retry')}">
        <i class="mdi mdi-refresh"></i>
      </button>
    </div>
    <p class="muted party-intro">${t('party.hint')}</p>
    <div id="party-body"><div class="empty-state">${t('common.loading')}</div></div>
  `;

  const body = root.querySelector('#party-body');
  let copiedTimer = null;

  root.querySelector('#party-refresh').addEventListener('click', () => void load());

  async function run(type, payload = {}) {
    try {
      await sendReportedCommand(type, payload);
    } catch {
      // The shared banner already said the action did not reach Beacon.
    }
    await load();
  }

  function actionButton(label, onClick, { primary = false, danger = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn party-action${primary ? ' btn-primary' : ''}${danger ? ' party-action--danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  async function copyLink(button, url) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    button.innerHTML = '<i class="mdi mdi-check"></i>';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      button.innerHTML = '<i class="mdi mdi-content-copy"></i>';
    }, 2000);
  }

  function render(status) {
    body.innerHTML = '';

    const notice = document.createElement('p');
    notice.className = 'party-notice';
    if (status.enabled) {
      if (status.hosted_here) {
        notice.textContent = t(status.server_hosted ? 'party.runsOnServer' : 'party.runsLocally');
        notice.classList.add(status.server_hosted ? 'party-notice--ok' : 'party-notice--warn');
      } else {
        notice.textContent = t('party.hostedElsewhere');
      }
      body.appendChild(notice);
    }

    if (status.enabled && status.invite_url) {
      const invitation = document.createElement('div');
      invitation.className = 'party-invitation';
      const label = document.createElement('div');
      label.className = 'eyebrow-label';
      label.textContent = t('party.invitation');
      const linkRow = document.createElement('div');
      linkRow.className = 'party-link';
      const link = document.createElement('span');
      link.className = 'party-link__url';
      link.textContent = status.invite_url;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'row-action party-link__copy';
      copy.title = t('party.copyLink');
      copy.setAttribute('aria-label', t('party.copyLink'));
      copy.innerHTML = '<i class="mdi mdi-content-copy"></i>';
      copy.addEventListener('click', () => void copyLink(copy, status.invite_url));
      linkRow.append(link, copy);
      invitation.append(label, linkRow);
      body.appendChild(invitation);
    }

    if (status.enabled) {
      const guests = document.createElement('div');
      guests.className = 'party-guests';
      const heading = document.createElement('div');
      heading.className = 'eyebrow-label';
      heading.textContent = t('party.guests', { count: n(status.guests.length) });
      guests.appendChild(heading);
      if (status.listen_kbps && status.listeners) {
        const listeners = document.createElement('p');
        listeners.className = 'muted party-listeners';
        listeners.textContent = t('party.listeners', { count: n(status.listeners) });
        guests.appendChild(listeners);
      }
      if (!status.guests.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = t('party.noGuests');
        guests.appendChild(empty);
      }
      for (const guest of status.guests) {
        const row = document.createElement('div');
        row.className = 'party-guest';
        const dot = document.createElement('i');
        dot.className = `mdi ${guest.connected ? 'mdi-circle' : 'mdi-circle-outline'} party-guest__dot`;
        if (guest.connected) dot.classList.add('party-guest__dot--on');
        const name = document.createElement('span');
        name.className = 'party-guest__name';
        name.textContent = guest.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'row-action';
        remove.title = t('party.removeGuest', { name: guest.name });
        remove.setAttribute('aria-label', remove.title);
        remove.innerHTML = '<i class="mdi mdi-account-remove"></i>';
        remove.addEventListener('click', () => void run('party-kick', { guestId: guest.id }));
        row.append(dot, name, remove);
        guests.appendChild(row);
      }
      body.appendChild(guests);
    }

    const actions = document.createElement('div');
    actions.className = 'party-actions';
    if (!status.enabled) {
      actions.appendChild(actionButton(t('party.start'), () => void run('party-enable'), { primary: true }));
    } else {
      actions.appendChild(
        actionButton(t('party.end'), () => void run('party-disable'), { danger: true }),
      );
      if (status.hosted_here) {
        actions.appendChild(
          actionButton(t('party.renewLink'), () => void run('party-rotate')),
        );
      } else {
        actions.appendChild(
          actionButton(t('party.takeOver'), () => void run('party-takeover')),
        );
      }
    }
    body.appendChild(actions);
  }

  async function load() {
    try {
      render(await fetchParty());
    } catch {
      body.innerHTML = `<div class="empty-state">${t('party.failed')}</div>`;
    }
  }

  load();

  return () => clearTimeout(copiedTimer);
}

registerRoute('/party', renderParty);
