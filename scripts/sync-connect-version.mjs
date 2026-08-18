import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Keeps the Connect backend's version markers in sync with the root
// package.json, so nobody has to remember to bump them by hand on release.
// Run automatically via the `postversion` hook (see package.json).

const packageFile = path.resolve(process.cwd(), 'package.json');
const { version } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

// semver pre-release (1.2.3-dev.0) -> PEP 440 (1.2.3.dev0), required by
// connect/pyproject.toml. Stable versions (1.2.3) pass through unchanged.
const pep440Version = version.replace(
    /-([a-zA-Z]+)\.?(\d+)?/,
    (_, tag, num) => `.${tag}${num ?? '0'}`,
);

const pyprojectFile = path.resolve(process.cwd(), 'connect/pyproject.toml');
const pyproject = fs.readFileSync(pyprojectFile, 'utf8');
fs.writeFileSync(
    pyprojectFile,
    pyproject.replace(/^version = ".*"$/m, `version = "${pep440Version}"`),
    'utf8',
);
console.log(`Updated ${pyprojectFile} with version ${pep440Version}`);

const sharedLyricsFile = path.resolve(process.cwd(), 'connect/lyrics/shared.py');
const sharedLyrics = fs.readFileSync(sharedLyricsFile, 'utf8');
fs.writeFileSync(
    sharedLyricsFile,
    sharedLyrics.replace(/^CONNECT_VERSION = ".*"$/m, `CONNECT_VERSION = "${version}"`),
    'utf8',
);
console.log(`Updated ${sharedLyricsFile} with version ${version}`);

// pyproject.toml's version is part of what uv.lock pins — without this,
// `uv sync --locked` (used by the Dockerfile) fails after every bump because
// the lockfile no longer matches the project version.
const connectDir = path.dirname(pyprojectFile);
execFileSync('uv', ['lock', '--project', connectDir], { stdio: 'inherit' });
console.log(`Updated ${path.join(connectDir, 'uv.lock')} with version ${pep440Version}`);
