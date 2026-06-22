# ⚰ Cemetery Dashboard

A connected cemetery dashboard that writes **session data to a database** and lets
you **search it from an iPhone or desktop browser**. Field workers start a logging
session, record graves/burials (name, section, plot, dates, GPS, notes), and every
entry is instantly searchable from any device on the network.

## Features

- **Sessions** — each survey/data-entry session is recorded with operator + device.
- **Records** — deceased name, section, plot, birth/death/burial dates, GPS
  coordinates, and free-form notes.
- **Full-text search** — SQLite **FTS5** powers fast, typo-tolerant prefix search
  across names, sections, plots, and notes.
- **Responsive UI** — mobile-first layout with iOS safe-area support; the same
  app works on iPhone, iPad, and desktop.
- **GPS capture** — tag a record with the phone's location; results link out to a map.
- **REST API** — clean JSON endpoints so other clients can read/write too.

## Tech

- **Node.js + Express** HTTP/JSON server
- **better-sqlite3** embedded SQL database (file-based, zero external services)
- Vanilla HTML/CSS/JS frontend (no build step)

## Quick start

```bash
npm install
npm run seed     # optional: load sample data
npm start        # http://localhost:3000
```

Open `http://localhost:3000` on your desktop. To use it on an **iPhone**, make
sure the phone is on the same network and visit `http://<your-computer-ip>:3000`
(GPS capture requires HTTPS or localhost — see notes below).

## Configuration

| Env var             | Default            | Description                          |
| ------------------- | ------------------ | ------------------------------------ |
| `PORT`              | `3000`             | HTTP port                            |
| `CEMETERY_DATA_DIR` | `./data`           | Directory for the SQLite file        |
| `CEMETERY_DB`       | `<dataDir>/cemetery.db` | Full path to the database file  |

## API

| Method   | Path                          | Description                          |
| -------- | ----------------------------- | ------------------------------------ |
| `GET`    | `/api/health`                 | Health check                         |
| `GET`    | `/api/stats`                  | Counts of sessions/records/sections  |
| `GET`    | `/api/sessions`               | List sessions (with record counts)   |
| `POST`   | `/api/sessions`               | Start a session `{name, operator, device}` |
| `POST`   | `/api/sessions/:id/end`       | End a session                        |
| `POST`   | `/api/sessions/:id/records`   | Add a record to a session            |
| `GET`    | `/api/records?q=&session_id=` | Search records (FTS5) or list recent |
| `GET`    | `/api/records/:id`            | Get one record                       |
| `DELETE` | `/api/records/:id`            | Delete a record                      |

### Example

```bash
# Start a session
SID=$(curl -s -XPOST localhost:3000/api/sessions \
  -H 'content-type: application/json' \
  -d '{"name":"North survey","operator":"Alex"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

# Add a record
curl -s -XPOST localhost:3000/api/sessions/$SID/records \
  -H 'content-type: application/json' \
  -d '{"deceased_name":"Jane Doe","section":"A","plot":"7","notes":"granite marker"}'

# Search
curl -s 'localhost:3000/api/records?q=jane'
```

## Notes

- The database (`data/cemetery.db`) is created automatically on first run and is
  git-ignored so survey data stays local.
- Browser **geolocation** only works over `https://` or `http://localhost`. For
  on-device GPS in the field, run behind a reverse proxy with TLS (e.g. Caddy)
  or a tunnel such as `cloudflared`/`ngrok`.
