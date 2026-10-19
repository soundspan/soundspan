# Backup and Restore

soundspan backs itself up from the Admin page and restores on the first-run
screen of a fresh install. One backup file holds everything in the database:
accounts, settings, service connections, playlists, listening history, and
your analyzed library. If your server dies, deploy soundspan again any way you
like, mount your music, and restore the file. Nothing needs a rescan or
re-analysis.

Two things stay your own job:

- **Your music files.** The backup never contains them. Back up the music
  folder with whatever tool you already use, and keep the files' modification
  times when you copy them back (for example `rsync -a` or `cp -a`).
- **Your deployment config.** The `.env` file, compose files, and Helm values
  are not in the backup. You don't need the old ones to restore: a new
  deployment with new secrets works, with the exceptions listed under
  [What changes with new secrets](#what-changes-with-new-secrets).

## What a backup restores

| Data                                                                     | In the backup | After a restore                                                                                           |
| ------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| Accounts, roles, passwords, and two-factor settings                      | Yes           | Everyone signs in again with their existing password.                                                     |
| System settings and service connections (Lidarr, Audiobookshelf, TIDAL, YouTube Music, scrobbling, and the rest of the Admin page) | Yes           | Stored passwords and tokens work: the restore re-protects them with the new server's key.                 |
| Links between accounts and single sign-on identities                     | Yes           | They work when the new server uses the same single sign-on provider address. See below.                   |
| Playlists, likes, play history, listening state, podcast and audiobook progress | Yes           | Back as they were.                                                                                        |
| Share links and invite codes                                             | Yes           | They keep working.                                                                                        |
| Library metadata: artists, albums, tracks, enrichment, lyrics            | Yes           | Back as they were. Tracks match your files by their path inside the music folder.                        |
| Audio analysis and vibe embeddings                                       | Yes           | Back as they were. Nothing is analyzed again.                                                             |
| Federation peers                                                         | Yes           | Outgoing connections work. Peers that connect to you may need new credentials; see below.                 |
| API keys and linked devices                                              | Yes           | They may need issuing again; see below.                                                                   |
| Music files                                                              | **No**        | Mount the same music folder. Its location on the host can change; its layout inside must not.            |
| Caches: covers, transcodes, podcast downloads, browse images             | **No**        | Rebuilt as needed. A missing album cover downloads again from your cover sources, or is read again from the album's embedded art, when it's shown. |
| Redis (job queues and short-lived state)                                 | **No**        | Rebuilt at startup. See [Why Redis is not backed up](#why-redis-is-not-backed-up).                        |
| Deployment config (`.env`, compose files, Helm values)                   | **No**        | Use any config you like for the new deployment.                                                           |

### How much you can lose

A backup is a snapshot of the moment you download it. If the server dies, you
lose everything that changed after your last backup: new plays, new likes,
playlist edits, and settings changes. Music you added after the backup is not
lost: the next library scan finds the files and analyzes them again.

Download a backup after any change you would hate to redo, and on a regular
schedule. Weekly suits most households. Keep more than one, somewhere other
than the server.

### Why Redis is not backed up

Everything durable lives in PostgreSQL. Scheduled jobs register themselves
again when soundspan starts, and downloads and imports pick up from the
database. A restore therefore loses only short-lived Redis state:

- outbound scrobbles that were still waiting to be sent;
- sign-in, account-link, and invite tokens that were in flight;
- live Listen Together sessions;
- rate-limit counters;
- job history in the queue dashboard.

### What changes with new secrets

A new deployment usually has a new `SETTINGS_ENCRYPTION_KEY`, a new
`SESSION_SECRET`, and possibly a new single sign-on setup. The restore handles
the encryption key for you. Three things depend on the others:

- **Sign-in sessions.** Everyone signs in again after a restore, because the
  new server signs sessions with its own secret.
- **API keys, linked devices, and incoming federation peers.** These are
  stored as one-way hashes keyed by the API-key pepper, and a one-way hash
  can't be moved to a new key. The pepper is the first of `API_KEY_PEPPER`,
  `SETTINGS_ENCRYPTION_KEY`, `ENCRYPTION_KEY`, and `SESSION_SECRET` that is
  set. When the new server's pepper differs, the restore summary says so, and
  you issue those keys and peer credentials again. To avoid that, set
  `API_KEY_PEPPER` on the new server to the old server's pepper value.
- **Single sign-on.** Single sign-on is configured with environment
  variables, so set it up on the new deployment. Account links match the
  provider by its issuer address, so `OIDC_ISSUER_URL` must be exactly the
  old server's value. Users who only ever signed in through single sign-on
  have no password, so they can't sign in until single sign-on works.

## Take a backup

1. Sign in as an admin.
2. Open **Admin → Backup**.
3. Type a passphrase of at least 12 characters twice.
4. Select **Download backup**.

Your browser downloads `soundspan-backup-<date>.soundspan-backup`. A large
library takes a while; keep the tab open until the download finishes. Then
check your browser's downloads list: if the download failed or stopped early,
start a new backup from the Admin page. The download link works once and
expires after five minutes. A restore checks the whole file and refuses one
that is incomplete.

The backup reads the whole database in one consistent snapshot, so people can
keep listening while it runs. One backup runs at a time, and a backup must
finish within six hours.

> **Keep the passphrase.** A backup can't be restored without it, and nobody
> can recover it for you. It protects the stored passwords and service
> connections in the file.

> **Store the file privately.** Apart from those credentials, the file is not
> encrypted. It holds usernames, password hashes, listening history, profile
> pictures, and working share links and invite codes. The passphrase also
> keys an integrity check, so a restore refuses a file that someone changed.

## Restore a backup

A restore runs only on a fresh install: a server where nobody has created an
account yet. It never overwrites a server that is in use.

### Before you start

- **Version:** deploy the same soundspan version the backup came from, or a
  newer one. The restore applies the newer version's database changes to your
  data, the same way an upgrade does. A backup that carries database changes
  this version doesn't know is refused.
- **Music:** mount your music folder. The backup finds tracks by their path
  inside it.
- **Old server:** turn it off if it still runs. Two servers restored from one
  backup share one federation identity. If the new server has a different
  public address, update that address on your federation peers.
- **Disk space for the upload:** the server stages the uploaded file next to
  its transcode cache, so that location needs free space of at least the
  file's size plus 10%, and it must be writable. That is the backend cache
  volume on Docker Compose, the data volume on the all-in-one container, and
  by default the music volume (`/music/.soundspan/`) on Helm. A backup can be
  up to 256 GiB.
- **Disk space for the database:** the restore loads everything in one
  transaction, so give the database volume at least as much free space as the
  old server's database used, with room to spare.
- **One backend replica:** the upload goes to one backend process. If you run
  more than one backend replica (Kubernetes HA, scaled Compose), scale the
  backend to one replica for the restore.
- **Reverse proxy:** the browser uploads the file in 4 MiB pieces. Make sure
  your reverse proxy accepts request bodies of at least 6 MB; see
  [Request body size](REVERSE_PROXY_AND_TUNNELS.md#request-body-size).

### Steps

1. Open the new server in your browser. The first-run screen appears.
2. Select **Restore from a backup**.
3. Choose the backup file and type its passphrase.
4. Select **Restore**. The page shows the upload, then the restore's progress.
   Keep the page open during the upload; leaving it cancels the upload. After
   the upload finishes you can close the page: the restore keeps going on the
   server, and opening the server again shows its progress.
5. When the page says **Restore complete. Restart soundspan to finish**,
   restart every soundspan container or pod:
   - All-in-one container: `docker restart soundspan`
   - Docker Compose: `docker compose restart`
   - Kubernetes: `kubectl -n <namespace> rollout restart deployment -l app.kubernetes.io/instance=<release>`
6. Sign in with an account from the backup.

While the restore runs, the API and the Subsonic API answer "A restore is in
progress". After it finishes, they answer "Restart soundspan to finish the
restore" until their process restarts. Background workers keep running until
you restart them, so restart every container or pod as soon as the restore
finishes.

If the passphrase is wrong, the page keeps the uploaded file and asks for the
passphrase again.

### What the restore does

1. It checks the whole file before it changes anything: the format, the
   passphrase and integrity check, that every row the backup lists is present,
   that the backup has an admin account, and the version.
2. It removes the fresh install's application tables, types, and functions.
   Database extensions stay.
3. It rebuilds the database structure of the backup's version from this
   version's own migration files.
4. It loads your data with triggers and links between tables switched off,
   switches them back on, rebuilds the vector indexes, and checks every
   table's row count.
5. It applies the database changes from newer versions.
6. It re-protects stored passwords and service connections with this
   server's encryption key.

If a step fails, the restore removes what it loaded and returns the server to
a fresh install, so you can fix the problem and retry. Two failures can leave
the database in between: the restore stopping part-way (for example because
the server restarted), and the cleanup itself failing. The page says which
one happened; reset the database as described below, then restore again.

### Why the file holds data only

Restoring a PostgreSQL dump runs whatever SQL the dump contains. The restore
page is open to anyone who reaches a fresh install, so soundspan never runs
SQL from an uploaded file. The file holds rows only. The database structure
always comes from the soundspan version you deployed, and every value is
loaded as a value, never as code.

## Reset the database

Resetting deletes everything in the database. Do it only on a server you are
restoring into.

- **All-in-one container:** `docker compose -f docker-compose.aio.yml down -v`,
  then `docker compose -f docker-compose.aio.yml up -d`. This deletes the
  whole data volume, including the caches and generated secrets.
- **Docker Compose:** `docker compose down -v`, then `docker compose up -d`.
  This deletes every named volume of the stack.
- **Kubernetes:** delete and recreate the database: the chart's
  `<release>-postgresql` volume claim, or the database on your external
  PostgreSQL server. Then restart soundspan.

## Troubleshooting

| Message                                                                | What to do                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| This server already has an account                                     | Restore into a fresh install, or [reset the database](#reset-the-database) first.              |
| This backup comes from a newer version                                 | Update this server to the backup's version or later, then restore.                             |
| That passphrase doesn't match this backup                              | Type the passphrase you chose when you downloaded the backup.                                  |
| This file isn't a complete backup, or the backup file is damaged       | The download was cut short or the file is damaged. Use another backup.                         |
| The upload expired or was cancelled                                    | Start the restore again and keep the page open until the upload finishes.                      |
| Another upload of a backup is in progress                              | Wait for it to finish. An upload whose page was closed expires after 15 minutes without activity. |
| Part of the upload reached a different backend replica                 | Scale the backend to one replica, then restore again.                                          |
| The server doesn't have enough free disk space                         | Free space where the server stages uploads (see [Before you start](#before-you-start)), then restore again. |
| A reverse proxy rejected the upload as too large                       | Let the proxy accept request bodies of at least 6 MB.                                          |
| The restore stopped before it finished, or couldn't return to a fresh install | [Reset the database](#reset-the-database), then restore again.                                 |
| Restart soundspan to finish the restore                                | Restart every soundspan container or pod.                                                      |
