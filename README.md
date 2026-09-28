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

## My Car

The **My Car** page is for the car being driven on the PC running the server:

- **Dash:** position (overall and class), lap, gear, speed, RPM bar with shift lights (using your car's shift points from iRacing), live delta to your best lap, current/last/best lap times, incidents, and pit limiter / engine warnings.
- **Fuel calculator:** fuel per lap (average of the last 5 green laps; laps with a pit visit are skipped), laps of fuel left, laps to go, and fuel still needed to finish. It runs on the server, so it keeps counting while your phone sleeps. Tiles can show these as `Calc_FuelPerLap`, `Calc_FuelLapsLeft`, `Calc_LapsRemaining` and `Calc_FuelToFinish`.
- **Pedal inputs** and tiles for any other car telemetry (water/oil temp, brake bias…).

When you're spectating (e.g. as league admin) the dash says so instead of showing zeros.

## Car controls and pit service

The **Car** page controls the car driven on the PC.

- **Pit service** (fuel, tires, tearoff, fast repair) uses iRacing SDK pit commands. These work without any setup and don't touch window focus.
- **Car controls** (ignition, starter, pit limiter, lights, wipers, brake bias…) have no SDK command, so the board presses the key each control is bound to in iRacing. It briefly focuses iRacing, the same way chat commands do. Each button's key combo has to match your iRacing binding:

| Button | Default combo | Notes |
|---|---|---|
| Ignition | `ctrl+shift+i` | |
| Starter | `ctrl+shift+s` | held for 1.5 s |
| Pit Limiter | `ctrl+shift+l` | |
| Headlights / Flash | `ctrl+shift+h` / `ctrl+shift+f` | |
| Wipers | `ctrl+shift+w` | |
| Brake bias − / + | `ctrl+shift+[` / `ctrl+shift+]` | |

To bind one: in iRacing, open Options → Controls, click the control's binding, then press the matching button on the board. Or change the button's combo to whatever key you already use. Supported key names: letters, digits, `f1`–`f24`, `num0`–`num9`, `num+ num- num* num/ num.`, arrows, `home end pgup pgdn ins del`, `space enter tab esc`, punctuation, and `ctrl` / `shift` / `alt` modifiers.

## iRacing SDK coverage

| SDK feature | Where it's used |
|---|---|
| All telemetry variables (including per-car `CarIdx…` arrays) | Tiles: any variable, e.g. `Speed`, `CarIdxPosition[target]` |
| Full session info (weekend, drivers, results, sessions, cameras, setup…) | Tiles: `si:` paths, e.g. `si:WeekendInfo.TrackSkies`, `si:DriverInfo.Drivers[target].IRating`, `si:SessionInfo.Sessions[current].ResultsPositions[0].CarIdx`. Browse everything at `http://<pc>:8420/api/session` |
| Camera switch (by car / position / leader / incident) | `camera` action |
| Camera state (hide UI, camera tool, auto shot selection, key/mouse modes) | `sdk` action → Camera / UI state (toggle, on, off, set) |
| Replay speed, search, jump N frames, jump to session time, erase tape | `replay` and `sdk` actions |
| Reload car textures (all or one car) | `sdk` action |
| Chat macros; open, reply to or close chat | `macro` and `sdk` actions |
| Pit service (fuel, tires, tearoff, fast repair, compound, clear) | `pit` action |
| Telemetry disk recording (.ibt start / stop / restart) | `sdk` action |
| Force-feedback max force | `sdk` action |
| Screenshot and video capture | `sdk` action |
| Anything else | `broadcast` action (raw `irsdk_broadcastMsg`) |

Readable formats exist for the SDK's bitfields and enums: flags, session state, pace mode, track surface, engine warnings, pit service flags and status, spotter (car left/right), track wetness and camera state.

Things the SDK can't do from outside the sim, such as car controls (ignition, lights, wipers…), are handled with key presses (see above).

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
