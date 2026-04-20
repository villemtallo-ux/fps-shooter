# Neon Siege — Co-op Multiplayer

2–4 player co-operative survival over WebSockets. One player hosts, the others
join with a 4-character room code. The host is authoritative for enemies and
wave progression; guests send shot/hit events which the host validates and
broadcasts.

## Requirements

- **Node.js v14+** — that's it. Zero npm packages. No `npm install` needed.
- If you can't install Node.js, download the standalone binary (zip) from
  https://nodejs.org/en/download — extract it and use the `node.exe` inside.

## Running

```powershell
node server.js
```

Or if using a portable node.exe:
```powershell
C:\path\to\node.exe  C:\path\to\shooter\server.js
```

You should see:

```
NEON SIEGE co-op server ready
  Local:    http://localhost:8787/
  Network:  http://<your-lan-ip>:8787/
```

- **Same machine:** everyone opens `http://localhost:8787/`
- **Same LAN:** find your LAN IP (`ipconfig`) and the others open
  `http://<that-ip>:8787/`.
- **Over the internet:** expose the port (e.g. `ngrok http 8787`) and share
  the forwarded URL.

## In-game flow

1. On the start screen, click **MULTIPLAYER**.
2. **HOST**: click *HOST GAME*, share the 4-character code.
3. **JOIN**: enter the code, click *JOIN*.
4. When everyone is in the lobby, the host clicks *START* — everyone drops
   into the arena together.

## Controls

Identical to singleplayer. All existing keybinds work.

## What's shared

| Thing                       | Synced? |
| --------------------------- | ------- |
| Player positions / rotations| yes (20 Hz) |
| Weapon held / firing        | yes     |
| Enemies (pos, hp, kills)    | yes (host authoritative, 10 Hz) |
| Wave number / progression   | yes (host drives it) |
| Map selection               | yes (host picks) |
| Player HP / armor / score   | **per-player** (not shared) |
| Upgrades / perks            | **per-player** |
| Pickups                     | per-client (for now) |

## Limitations (honest list)

- Enemy motion is smooth on host, lightly interpolated for guests.
- Dedicated cheat prevention is **not** implemented — play with friends.
- Pickups are not yet synced; each client sees their own.
- If the host disconnects, host is migrated to the next player; enemies reset
  to whatever state the new host sees locally.

## Troubleshooting

- **"Can't connect / WebSocket error"** — firewall prompt on the host's
  machine. Allow Node.js through Windows Defender Firewall.
- **"Room not found"** — code is case-insensitive; check for typos
  (codes use unambiguous characters: no `0/O`, `1/I`).
- **Desync** — rejoin. Guest state is rebuilt from the next host snapshot.
