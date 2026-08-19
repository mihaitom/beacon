import fs from 'fs';
import path from 'path';

// Turns CHANGELOG.md's [Unreleased] heading into a dated version one, using
// the version package.json now has (already bumped by the `pnpm version`
// step this runs after) and today's date — run automatically via the
// `postversion` hook (see package.json), same as sync-connect-version.mjs,
// so `pnpm bump-version <patch|minor|major>` is the one command that
// finishes a release's changelog too, instead of something to remember to
// do by hand every time.
//
// A straight rename, not leaving a fresh empty [Unreleased] behind — this
// runs on whatever branch bump-version is run on, and that branch (main,
// for an actual release) ends up pushed/merged as-is; an empty [Unreleased]
// heading with nothing under it would land there too, permanently, which
// reads as "something's missing" rather than "nothing's happened yet since
// this release". The next real changelog entry, whenever it lands (likely
// back on a development branch), just adds the [Unreleased] heading back
// itself instead of relying on it already being there.

const packageFile = path.resolve(process.cwd(), 'package.json');
const { version } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, matches every existing heading in the file

const changelogFile = path.resolve(process.cwd(), 'CHANGELOG.md');
const changelog = fs.readFileSync(changelogFile, 'utf8');

const unreleasedHeading = '## [Unreleased]';
if (!changelog.includes(unreleasedHeading)) {
    console.log(`No "${unreleasedHeading}" heading found in ${changelogFile} — nothing to finalize.`);
    process.exit(0);
}

// Only the first occurrence — later ones (there shouldn't be any, but if
// this ever runs twice against the same content) are left untouched rather
// than each renaming another version heading.
const updated = changelog.replace(unreleasedHeading, `## [${version}] - ${today}`);
fs.writeFileSync(changelogFile, updated, 'utf8');
console.log(`Updated ${changelogFile}: [Unreleased] -> [${version}] - ${today}`);
