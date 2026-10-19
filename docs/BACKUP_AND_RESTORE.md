# Backup and Restore

soundspan backs itself up from the Admin page and restores on the first-run
screen of a fresh install. One backup file holds everything in the database:
accounts, settings, service connections, playlists, listening history, and
your analyzed library. If your server dies, deploy soundspan again any way you
like, mount your music, and restore the file. Nothing needs a rescan or
re-analysis.

Two things stay your own job:

- **Your music files.** The backup never contains them. Back up the music
  folder with whatever tool you already use.
- **Your deployment config.** The `.env` file, compose files, and Helm values
  are not in the backup. You don't need the old ones to restore: a new
  deployment with new secrets works.

## What a backup restores

| Data                                                                     | In the backup | After a restore                                                                                           |
| ------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| Accounts, roles, passwords, and two-factor settings                      | Yes           | Everyone signs in again with their existing password.                                                     |
| System settings and service connections (Lidarr, Audiobookshelf, TIDAL, YouTube Music, scrobbling, and the rest of the Admin page) | Yes           | Stored passwords and tokens work: the restore re-protects them with the new server's key.                 |
| Links between accounts and single sign-on identities                     | Yes           | Back as they were. Single sign-on itself is set up with environment variables, so configure it on the new deployment. |
| Playlists, likes, play history, listening state, podcast and audiobook progress | Yes           | Back as they were.                                                                                        |
| Library metadata: artists, albums, tracks, enrichment, lyrics            | Yes           | Back as they were. Tracks match your files by their path inside the music folder.                        |
| Audio analysis and vibe embeddings                                       | Yes           | Back as they were. Nothing is analyzed again.                                                             |
| Federation peers                                                         | Yes           | Outgoing connections work. Peers that connect to you need new credentials if the API-key pepper changed (see below). |
| API keys and linked devices                                              | Yes           | They keep working only if the new server uses the same API-key pepper. Otherwise, issue them again.       |
| Music files                                                              | **No**        | Mount the same music folder. Its location on the host can change; its layout inside must not.            |
| Caches: covers, transcodes, podcast downloads, browse images             | **No**        | Rebuilt as needed. Covers download again or come from your files' embedded art.                           |
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

### The API-key pepper

API keys, linked devices, and the credentials that federation peers use to
connect to you are stored as one-way hashes keyed by the API-key pepper. A
one-way hash can't be moved to a new key. The pepper is `API_KEY_PEPPER` when
you set it; otherwise it is `SETTINGS_ENCRYPTION_KEY`, which a new deployment
usually generates fresh. When the pepper differs, the restore says so, and you
issue those keys and peer credentials again. To avoid that, set
`API_KEY_PEPPER` on the new server to the old server's value.

## Take a backup

1. Sign in as an admin.
2. Open **Admin → Backup**.
3. Type a passphrase of at least 12 characters twice.
4. Select **Download backup**.

Your browser downloads `soundspan-backup-<date>.soundspan-backup`. A large
library takes a while; keep the tab open until the download finishes. The
download link works once and expires after five minutes, so if the download
fails, start it again from the Admin page.

The backup reads the whole database in one consistent snapshot, so people can
keep listening while it runs. One backup runs at a time.

> **Keep the passphrase.** A backup can't be restored without it, and nobody
> can recover it for you. It protects the stored passwords and service
> connections in the file.

> **Store the file privately.** Apart from those credentials, the file is not
> encrypted. It holds usernames, password hashes, listening history, and
> profile pictures.

## Restore a backup

A restore runs only on a fresh install: a server where nobody has created an
account yet. It never overwrites a server that is in use.

### Before you start

- **Version:** deploy the same soundspan version the backup came from, or a
  newer one. The restore applies the newer version's database changes to your
  data, the same way an upgrade does. A backup from a newer version is
  refused.
- **Music:** mount your music folder. The backup finds tracks by their path
  inside it.
- **Old server:** turn it off if it still runs. Two servers restored from one
  backup share one federation identity.
- **Disk space:** the server stages the uploaded file next to its caches, so
  it needs free space of at least the file's size plus 10%.
- **One backend replica:** the upload goes to one backend process. If you run
  more than one backend replica (Kubernetes HA, scaled Compose), scale the
  backend to one replica for the restore.
- **Reverse proxy:** the browser uploads the file in 4 MiB pieces. Make sure
  your reverse proxy accepts request bodies of at least 5 MB; see
  [Request body size](REVERSE_PROXY_AND_TUNNELS.md#request-body-size).

### Steps

1. Open the new server in your browser. The first-run screen appears.
2. Select **Restore from a backup**.
3. Choose the backup file and type its passphrase.
4. Select **Restore**. The page shows the upload, then the restore's progress.
   After the upload finishes you can close the page; the restore keeps going
   on the server.
5. When the page says **Restore complete. Restart soundspan to finish**,
   restart every soundspan container or pod:
   - All-in-one container: `docker restart soundspan`
   - Docker Compose: `docker compose restart`
   - Kubernetes: `kubectl rollout restart deployment -l app.kubernetes.io/instance=<your release>`
6. Sign in with an account from the backup.

Until the restart, soundspan answers every request with "Restart soundspan to
finish the restore", so nothing runs with state from before the restore.

If the passphrase is wrong, the page keeps the uploaded file and asks for the
passphrase again.

### What the restore does

1. It checks the whole file before it changes anything: the format, that
   every row the backup lists is present, the passphrase, and the version.
2. It removes the fresh install's empty tables.
3. It rebuilds the database structure of the backup's version from this
   version's own migration files.
4. It loads your data, then switches indexes, triggers, and links between
   tables back on and checks every table's row count.
5. It applies the database changes from newer versions.
6. It re-protects stored passwords and service connections with this
   server's encryption key.

If any step fails, the restore undoes its work and the server is a fresh
install again, so you can fix the problem and retry.

### Why the file holds data only

Restoring a PostgreSQL dump runs whatever SQL the dump contains. The restore
page is open to anyone who reaches a fresh install, so soundspan never runs
SQL from an uploaded file. The file holds rows only. The database structure
always comes from the soundspan version you deployed, and every value is
loaded as a value, never as code.

## Troubleshooting

| Message                                                                | What to do                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| This server already has an account                                     | Restore into a fresh install. To reuse this server, remove its database and start over.        |
| This backup comes from a newer version                                 | Update this server to the backup's version or later, then restore.                             |
| That passphrase doesn't match this backup                              | Type the passphrase you chose when you downloaded the backup.                                  |
| This file isn't a complete backup                                      | The download was cut short or the file is damaged. Use another backup.                         |
| Part of the upload reached a different backend replica                 | Scale the backend to one replica, then restore again.                                          |
| The server doesn't have enough free disk space                         | Free space on the volume that holds the caches, then restore again.                            |
| Restart soundspan to finish the restore                                | Restart every soundspan container or pod.                                                      |
