# Apps by others

`external-sources.json` lists external sources that people have written and
published themselves. Beacon reads it from the `main` branch and shows it
under Settings > Library > External sources > **Find apps**, so whoever
sets Beacon up can find an app and add it as a tab.

These apps are not part of Beacon. Their authors make and run them, and they
answer for what an app does and where its audio comes from. Beacon does not
check them. Whoever adds one decides whether they may play what it plays.

## Listing your app

Open a pull request that adds one entry to `apps` in
`external-sources.json`:

```json
{
  "name": "My source",
  "description": "What it plays, in a sentence or two.",
  "repository": "https://github.com/you/my-source",
  "icon": "mdi-album"
}
```

| Field         | What                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | The app's name, up to 60 characters. Beacon suggests it as the tab's name                                                                                                              |
| `description` | What it plays and how, in English, up to 300 characters. Plain text                                                                                                                    |
| `repository`  | Its public repository, an `https://` address. Its README says how to run the app and connect it                                                                                        |
| `icon`        | Optional. One of the tab icons Beacon offers (`EXTERNAL_SOURCE_ICONS` in `src/renderer/src/services/connect/externalSource.ts`); Beacon suggests it for the tab. `mdi-web` if left out |

What an entry needs to be taken in:

- The app works as the [External source API](../docs/help/reference/external-source-api.md)
  describes, and its repository says how to run it.
- The repository is public, and its README says where the audio comes from.
- One entry per app. A change to an entry comes from its author.

An entry can be taken out again, for example when its repository is gone,
the app stops working with Beacon, or its author asks for it.

The frontend tests read this file the way Beacon does and fail on an entry
Beacon would leave out, so a pull request shows a broken entry right away.
