# Race Control Board

A small web server that runs on your iRacing PC and turns any phone or tablet on your
local network into a customizable button board for league admin work: wave-arounds,
penalties, cautions, pit open/close, camera and replay control. It also shows live
telemetry (driver list, flags, laps, incidents).

## Run it

```
start.bat            # real iRacing
start.bat --demo     # fake 20-car session, so you can try the board without the sim
```

(or `python server.py [--demo] [--port 8420]`)

The console prints the address to open, e.g. `http://192.168.1.50:8420`. On an iPhone or iPad,
open it in Safari, then **Share → Add to Home Screen** to get a full-screen app.

**Windows Firewall:** the first time, Windows asks whether Python may accept connections.
Allow it on **Private** networks. If you missed the prompt, run this in an admin terminal:

```
netsh advfirewall firewall add rule name="Race Control Board" dir=in action=allow protocol=TCP localport=8420 profile=private
```

## How it talks to iRacing

| What | How |
|---|---|
| Telemetry | Reads iRacing's shared memory (`Local\IRSDKMemMapFileName`) at up to 60 Hz, and parses session info for drivers, incidents and camera groups. |
| Camera, replay, chat macros | iRacing SDK broadcast messages (`irsdk_broadcastMsg`). These work in the background. |
| Admin commands (`!waveby`, `!black`, `!eol`, `!yellow`, …) | The SDK can't send chat text directly, so the server opens chat through the SDK and types the command as keyboard input. By default it briefly brings iRacing to the front, types, presses Enter, then gives focus back to the previous window. |

Your iRacing account needs admin rights in the session for `!` commands to work.
If typing is unreliable on your machine, open **Menu → Server settings** and either raise the
delays or switch to the "Background" typing method.

## Using the board

- **Target car:** tap the chip in the top bar, the target card, or a row in the driver list.
  Buttons that use `{car}` act on the target. If you haven't picked one, the driver picker opens first.
- **Confirmation:** buttons can show the exact command before sending it.
- **Hold-to-fire:** dangerous buttons (DQ, remove) only fire after you hold them down.
- **Command log:** records every command, which device sent it, and whether it failed.

## Customizing

Tap **✎** to edit the layout.

- **+** adds an item from presets (race control, camera/replay, telemetry tiles, widgets) or a blank one.
- Tap an item to edit it; drag **⠿** to move it. Tap the active tab to rename the page, reorder it,
  or set how many columns it has on phones and on tablets.
- Each button runs a list of **actions** in order:
  - `chat` — any text. Tokens: `{car}` `{name}` `{team}` `{pos}` `{class}` `{idx}`.
    `{input:Seconds=10}` asks for a value when the button is pressed.
  - `camera` — focus a car (`{car}`, a number, `leader`, `incident`, `exiting`) or a race position,
    in a camera group (name or number).
  - `replay` — play, pause, speed (negative rewinds), jump to incident/lap/session, go live.
  - `macro` — iRacing chat macro 1–15.
  - `delay` — wait between steps.
  - `broadcast` — raw SDK broadcast message, for anything else.
- **Tiles** show any telemetry variable (autocomplete lists everything iRacing exposes).
  Per-car arrays take an index: `CarIdxLastLapTime[target]`, `[cam]`, `[player]`, `[5]`.
  Derived values: `@sessionType`, `@leaderLap`, `@carsOnPitRoad`, `@targetIncidents`, `@camCar`, …
- Every item also has a raw JSON editor (the **{ }** button).

The layout is stored on the PC in `data/config.json`, so every device sees the same board and
changes appear everywhere at once. Button size, text size and phone/tablet column mode are
set per device (**Menu → This device**). **Menu → Import / export** backs up or shares the layout as JSON.

## Security

- By default only private/LAN addresses can connect.
- Set a **PIN** in Server settings if others share your network.
- Only plain HTTP is served. Don't expose this port to the internet.

## Files

```
server.py            web server, WebSocket, action runner
irsdk.py             shared-memory telemetry reader + SDK broadcast/chat typing (ctypes)
demo.py              fake session for --demo
default_config.json  starting layout (copied to data/config.json on first save)
static/              the web app (vanilla JS, no build step)
```
