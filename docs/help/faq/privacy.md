---
order: 8
---

# What leaves the deployment

## What does Beacon send to outside services?

Settings > About Beacon > **Privacy** lists every outside service Beacon asks - Radio Browser, the lyrics providers, MusicBrainz, ListenBrainz and the rest - with what each one is asked for, what goes out with the request, and which setting turns it off. It is kept there rather than here so that there is one list, and it is the one in the app.

## Who can see what I listen to?

For the Stats page, your Beacon server keeps a record of which songs you played and when, per account. Administrators of your media server can open the Stats page of the other accounts on that server, and with it this record. Other Beacon users cannot. An app you made a key for sees what that key allows, which can include what you are playing at that moment, see [Your own apps](apps-and-api.md).

If a Last.fm or ListenBrainz name is set up, Beacon reads the public listens of that profile for the past year once, to fill in the listening year. It reads them and sends nothing back.
