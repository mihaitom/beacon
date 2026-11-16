import fs from 'fs';
import path from 'path';

// Asks every repository in community/external-sources.json - and every
// picture an entry links - whether it is still there. Beacon's own test
// checks what an entry says; only this one goes out to see whether the
// address still leads anywhere, so it runs on its own (check-community-
// apps.yml), not with the unit tests, which must not depend on the network.
//
// Gone (404, 410) fails. Anything else that goes wrong - a timeout, a rate
// limit, a host that is down for a moment - is only reported: one bad hour
// at GitHub must not take an app out of the list.

const TIMEOUT_MS = 15_000;
const file = path.resolve(process.cwd(), 'community/external-sources.json');
const { apps } = JSON.parse(fs.readFileSync(file, 'utf8'));

async function ask(url) {
    // HEAD first; a few hosts refuse it, so GET when they do.
    for (const method of ['HEAD', 'GET']) {
        const response = await fetch(url, {
            method,
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'User-Agent': 'beacon-community-check' },
        });
        await response.body?.cancel();
        if (method === 'HEAD' && (response.status === 405 || response.status === 501)) continue;
        return response.status;
    }
}

async function check(label, url) {
    let status;
    try {
        status = await ask(url);
    } catch (error) {
        console.log(`::warning::${label}: could not ask ${url} (${error.message})`);
        return 'unsure';
    }
    if (status === 404 || status === 410) {
        console.log(`::error::${label}: ${url} is gone (${status})`);
        return 'gone';
    }
    if (status >= 400) {
        console.log(`::warning::${label}: ${url} answered ${status}`);
        return 'unsure';
    }
    console.log(`ok    ${label}: ${url}`);
    return 'ok';
}

const results = [];
for (const app of Array.isArray(apps) ? apps : []) {
    const name = app?.name ?? '(no name)';
    if (typeof app?.repository === 'string') {
        results.push(await check(name, app.repository));
    }
    // A picture is an address; an icon name is not.
    if (typeof app?.icon === 'string' && app.icon.startsWith('https://')) {
        results.push(await check(`${name} (picture)`, app.icon));
    }
}

const gone = results.filter((result) => result === 'gone').length;
const unsure = results.filter((result) => result === 'unsure').length;
console.log(`\n${results.length} addresses: ${gone} gone, ${unsure} could not be checked.`);
process.exit(gone ? 1 : 0);
