"""Race Control Board - a LAN web button-board for iRacing league admins.

    python server.py            # real iRacing
    python server.py --demo     # fake session for trying things out
"""
import argparse
import asyncio
import copy
import ipaddress
import json
import logging
import os
import re
import socket
import sys
import time
from collections import deque
from pathlib import Path

from aiohttp import WSMsgType, web

import irsdk
from irsdk import CommandError

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
CONFIG_PATH = DATA_DIR / "config.json"
DEFAULT_CONFIG_PATH = ROOT / "default_config.json"

DEFAULT_SETTINGS = {
    "pin": "",
    "lanOnly": True,
    "telemetryHz": 10,
    "chatMethod": "sendinput",  # "sendinput" (focuses iRacing and types) or "postmessage" (background)
    "chatOpenDelayMs": 120,
    "chatCharDelayMs": 8,
    "chatSubmitDelayMs": 60,
    "restoreFocus": True,
}

# Always sent so the header, driver list and target card work
CORE_VARS = [
    "SessionTime", "SessionTimeRemain", "SessionLapsRemainEx", "SessionNum", "SessionState",
    "SessionFlags", "PaceMode", "CamCarIdx", "PlayerCarIdx", "CarIdxPosition", "CarIdxClassPosition",
    "CarIdxLap", "CarIdxLapCompleted", "CarIdxLapDistPct", "CarIdxOnPitRoad", "CarIdxTrackSurface",
    "CarIdxLastLapTime", "CarIdxBestLapTime", "CarIdxSessionFlags",
]

log = logging.getLogger("board")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


# --------------------------------------------------------------------------------------
# Fuel calculator for the car being driven on this PC. Runs server-side so the history
# survives phones sleeping/reloading.
# --------------------------------------------------------------------------------------

FUEL_VARS = ["SessionNum", "LapCompleted", "FuelLevel", "OnPitRoad", "IsOnTrack",
             "SessionLapsRemainEx", "SessionTimeRemain", "LapLastLapTime", "LapBestLapTime"]
CALC_VARS = {
    "Calc_FuelPerLap": "Average fuel used per green lap (last 5, pit laps excluded)",
    "Calc_FuelLapsLeft": "Laps the current fuel will last",
    "Calc_LapsRemaining": "Estimated laps left in the session for you",
    "Calc_FuelToFinish": "Extra fuel needed to reach the finish (0 = enough)",
}


class FuelTracker:
    def __init__(self):
        self.session = None
        self.reset()

    def reset(self):
        self.laps = deque(maxlen=5)
        self.last_lap = None
        self.fuel_at_start = None
        self.pitted = False

    def update(self, d):
        if d.get("SessionNum") != self.session:
            self.session = d.get("SessionNum")
            self.reset()
        lap, fuel = d.get("LapCompleted"), d.get("FuelLevel")
        if lap is None or fuel is None or not d.get("IsOnTrack"):
            return
        if d.get("OnPitRoad"):
            self.pitted = True
        if self.last_lap is None or lap < self.last_lap:
            self.last_lap, self.fuel_at_start, self.pitted = lap, fuel, bool(d.get("OnPitRoad"))
            return
        if lap > self.last_lap:
            used = (self.fuel_at_start or 0) - fuel
            if lap == self.last_lap + 1 and not self.pitted and used > 0:
                self.laps.append(used)
            self.last_lap, self.fuel_at_start, self.pitted = lap, fuel, bool(d.get("OnPitRoad"))

    def values(self, d):
        if not self.laps:
            return {}
        per_lap = sum(self.laps) / len(self.laps)
        out = {"Calc_FuelPerLap": round(per_lap, 3)}
        fuel = d.get("FuelLevel")
        if fuel is not None:
            out["Calc_FuelLapsLeft"] = round(fuel / per_lap, 2)
        laps_left = d.get("SessionLapsRemainEx")
        if laps_left is None or laps_left >= 32767:
            lap_time = d.get("LapLastLapTime") or 0
            lap_time = lap_time if lap_time > 0 else (d.get("LapBestLapTime") or 0)
            remain = d.get("SessionTimeRemain")
            laps_left = (remain / lap_time + 1) if lap_time > 0 and remain is not None and remain < 86400 else None
        if laps_left is not None:
            out["Calc_LapsRemaining"] = round(laps_left, 1)
            if fuel is not None:
                out["Calc_FuelToFinish"] = round(max(0.0, laps_left * per_lap - fuel), 2)
        return out


# --------------------------------------------------------------------------------------
# Config persistence
# --------------------------------------------------------------------------------------

def load_config():
    cfg = None
    for path in (CONFIG_PATH, DEFAULT_CONFIG_PATH):
        if path.exists():
            try:
                cfg = json.loads(path.read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                log.exception("Could not read %s", path)
    cfg = cfg or {"pages": []}
    cfg["settings"] = {**DEFAULT_SETTINGS, **(cfg.get("settings") or {})}
    return cfg


def save_config(cfg):
    DATA_DIR.mkdir(exist_ok=True)
    if CONFIG_PATH.exists():
        os.replace(CONFIG_PATH, CONFIG_PATH.with_suffix(".bak.json"))
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)


def validate_config(cfg):
    if not isinstance(cfg, dict) or not isinstance(cfg.get("pages"), list):
        raise ValueError("config must be an object with a 'pages' list")
    for p in cfg["pages"]:
        if not isinstance(p, dict) or not isinstance(p.get("items", []), list):
            raise ValueError("each page must be an object with an 'items' list")
    settings = cfg.get("settings") or {}
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    cfg["settings"] = {**DEFAULT_SETTINGS, **settings}
    return cfg


# --------------------------------------------------------------------------------------
# App state
# --------------------------------------------------------------------------------------

class Client:
    def __init__(self, ws, device, remote):
        self.ws = ws
        self.device = device
        self.remote = remote
        self.subs = set()

    async def send(self, obj):
        await self.send_str(json.dumps(obj, separators=(",", ":")))

    async def send_str(self, s):
        if self.ws.closed:
            return
        try:
            await self.ws.send_str(s)
        except (ConnectionError, RuntimeError):
            pass


class Board:
    def __init__(self, source, commands):
        self.source = source
        self.commands = commands
        self.config = load_config()
        self.clients = set()
        self.log = deque(maxlen=250)
        self.run_lock = asyncio.Lock()
        self.fuel = FuelTracker()

    @property
    def settings(self):
        return self.config["settings"]

    async def broadcast(self, obj, exclude=None):
        s = json.dumps(obj, separators=(",", ":"))
        await asyncio.gather(*(c.send_str(s) for c in list(self.clients) if c is not exclude))

    async def add_log(self, client, text, ok=True, error=None):
        entry = {"ts": time.time(), "device": client.device if client else "server",
                 "text": text, "ok": ok, "error": error}
        self.log.append(entry)
        (log.info if ok else log.warning)("%s: %s%s", entry["device"], text, "" if ok else "  -> " + str(error))
        await self.broadcast({"t": "log", "entry": entry})

    # actions --------------------------------------------------------------------------
    def _cam_group(self, group):
        if group in (None, "", "current"):
            return 0
        try:
            return int(group)
        except (TypeError, ValueError):
            pass
        for cam in (self.source.session or {}).get("cameras", []):
            if str(cam["name"]).lower() == str(group).lower():
                return cam["num"]
        raise CommandError("Camera group %r not found in this session" % group)

    async def execute(self, action):
        """Run a single resolved action. Returns a human-readable description for the log."""
        loop = asyncio.get_running_loop()
        cmds = self.commands
        t = action.get("type")

        def blocking(fn, *args):
            return loop.run_in_executor(None, fn, *args)

        if t == "chat":
            text = _CTRL.sub(" ", str(action.get("text", ""))).strip()[:250]
            if not text:
                raise CommandError("Chat text is empty")
            await blocking(cmds.chat, text, dict(self.settings))
            return text
        if t == "macro":
            n = int(action.get("n", 1))
            if not 1 <= n <= 15:
                raise CommandError("Macro must be 1-15")
            await blocking(cmds.chat_macro, n)
            return "chat macro %d" % n
        if t == "camera":
            group = self._cam_group(action.get("group"))
            camera = int(action.get("camera") or 0)
            if action.get("mode") == "position":
                pos = int(action.get("position") or 1)
                await blocking(cmds.cam_switch_pos, pos, group, camera)
                return "camera -> P%d (group %s)" % (pos, group)
            car = str(action.get("car", "")).strip()
            if not car:
                raise CommandError("No car for camera action")
            await blocking(cmds.cam_switch_num, car, group, camera)
            return "camera -> %s (group %s)" % (car, action.get("group") or "current")
        if t == "replay":
            op = action.get("op", "play")
            if op == "play":
                await blocking(cmds.replay_speed, 1, False)
            elif op == "pause":
                await blocking(cmds.replay_speed, 0, False)
            elif op == "speed":
                await blocking(cmds.replay_speed, int(action.get("speed", 1)), bool(action.get("slow")))
            elif op == "live":
                await blocking(cmds.replay_search, "toEnd")
                await blocking(cmds.replay_speed, 1, False)
            elif op == "search":
                mode = action.get("mode", "toEnd")
                if mode not in irsdk.REPLAY_SEARCH_MODES:
                    raise CommandError("Unknown replay search %r" % mode)
                await blocking(cmds.replay_search, mode)
            else:
                raise CommandError("Unknown replay op %r" % op)
            return "replay %s" % " ".join(str(action.get(k)) for k in ("op", "mode", "speed") if action.get(k) is not None)
        if t == "broadcast":
            args = [int(action.get(k) or 0) for k in ("msg", "var1", "var2")]
            var3 = action.get("var3")
            await blocking(cmds.broadcast, *args, None if var3 in (None, "") else int(var3))
            return "broadcast %s" % args
        if t == "delay":
            ms = min(10000, max(0, int(action.get("ms", 0))))
            await asyncio.sleep(ms / 1000)
            return None
        raise CommandError("Unknown action type %r" % t)

    async def run(self, client, msg):
        rid = msg.get("id")
        actions = msg.get("actions")
        if not isinstance(actions, list) or not actions:
            await client.send({"t": "result", "id": rid, "ok": False, "error": "No actions"})
            return
        label = str(msg.get("label") or "")[:60]
        async with self.run_lock:
            for action in actions:
                try:
                    desc = await self.execute(action)
                except Exception as e:  # report anything back to the button that fired it
                    if not isinstance(e, (CommandError, ValueError, TypeError, KeyError)):
                        log.exception("Action failed")
                    await self.add_log(client, "%s: %s" % (label, action.get("text") or action.get("type")), False, str(e) or type(e).__name__)
                    await client.send({"t": "result", "id": rid, "ok": False, "error": str(e)})
                    return
                if desc:
                    await self.add_log(client, desc)
        await client.send({"t": "result", "id": rid, "ok": True})

    # telemetry pump -------------------------------------------------------------------
    async def pump(self):
        last_status = last_session = None
        while True:
            hz = min(30, max(1, int(self.settings.get("telemetryHz") or 10)))
            await asyncio.sleep(1 / hz)
            status = self.source.status()
            fuel_data = self.source.get(FUEL_VARS) if status["connected"] else {}
            self.fuel.update(fuel_data)  # keep tracking even with no devices connected
            if not self.clients:
                continue
            if status != last_status:
                last_status = status
                await self.broadcast({"t": "status", **status})
            if self.source.session_version != last_session:
                last_session = self.source.session_version
                await self.broadcast({"t": "session", "d": self.source.session})
            if not status["connected"]:
                continue
            names = set(CORE_VARS)
            for c in self.clients:
                names |= c.subs
            data = self.source.get(names)
            data.update(self.fuel.values(fuel_data))
            if data:
                await self.broadcast({"t": "tel", "d": data})


# --------------------------------------------------------------------------------------
# HTTP / WebSocket
# --------------------------------------------------------------------------------------

def _is_lan(remote):
    if not remote:
        return False
    try:
        ip = ipaddress.ip_address(remote.split("%", 1)[0])
    except ValueError:
        return False
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_loopback or ip.is_link_local


@web.middleware
async def guard(request, handler):
    board = request.app["board"]
    if board.settings.get("lanOnly", True) and not _is_lan(request.remote):
        log.warning("Rejected non-LAN request from %s", request.remote)
        raise web.HTTPForbidden(text="LAN access only")
    resp = await handler(request)
    if request.path == "/" or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def _pin_ok(board, supplied):
    pin = str(board.settings.get("pin") or "")
    return not pin or supplied == pin


async def index(request):
    return web.FileResponse(STATIC_DIR / "index.html")


async def api_vars(request):
    board = request.app["board"]
    if not _pin_ok(board, request.headers.get("X-Pin", "")):
        raise web.HTTPUnauthorized()
    calc = [{"name": n, "desc": d, "unit": "", "count": 1, "type": "calc"} for n, d in CALC_VARS.items()]
    return web.json_response(board.source.var_list() + calc)


async def ws_handler(request):
    board = request.app["board"]
    ws = web.WebSocketResponse(heartbeat=15)
    await ws.prepare(request)
    if not _pin_ok(board, request.query.get("pin", "")):
        await ws.send_json({"t": "auth", "ok": False})
        await ws.close()
        return ws

    device = (request.query.get("device") or request.remote or "device")[:40]
    client = Client(ws, device, request.remote)
    board.clients.add(client)
    log.info("%s connected from %s (%d clients)", device, request.remote, len(board.clients))
    try:
        await client.send({
            "t": "hello", "config": board.config, "status": board.source.status(),
            "session": board.source.session, "log": list(board.log)[-100:],
        })
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            try:
                msg = json.loads(m.data)
            except ValueError:
                continue
            t = msg.get("t")
            if t == "sub":
                client.subs = {str(v) for v in (msg.get("vars") or [])[:200]}
            elif t == "run":
                asyncio.create_task(board.run(client, msg))
            elif t == "saveConfig":
                try:
                    cfg = validate_config(copy.deepcopy(msg.get("config")))
                except ValueError as e:
                    await client.send({"t": "error", "error": "Config rejected: %s" % e})
                    continue
                board.config = cfg
                save_config(cfg)
                await board.broadcast({"t": "config", "config": cfg, "by": client.device})
            elif t == "clearLog":
                board.log.clear()
                await board.broadcast({"t": "logCleared"})
    finally:
        board.clients.discard(client)
        log.info("%s disconnected (%d clients)", device, len(board.clients))
    return ws


def lan_addresses():
    addrs = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            addrs.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8420)
    ap.add_argument("--demo", action="store_true", help="run with a fake session instead of iRacing")
    ap.add_argument("--data", help="folder for the saved layout (default: ./data)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    if args.data:
        global DATA_DIR, CONFIG_PATH
        DATA_DIR = Path(args.data).resolve()
        CONFIG_PATH = DATA_DIR / "config.json"
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")

    if args.demo or not irsdk.IS_WINDOWS:
        import demo
        source = demo.DemoSource()
        commands = demo.DemoCommands(source)
        if not args.demo:
            log.warning("Not on Windows - starting in demo mode")
    else:
        source = irsdk.IRacingSource()
        commands = irsdk.IRacingCommands()
    source.start()

    board = Board(source, commands)
    app = web.Application(middlewares=[guard])
    app["board"] = board
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/vars", api_vars)
    app.router.add_static("/static/", STATIC_DIR)

    async def start_pump(app):
        loop = asyncio.get_running_loop()

        def quiet_resets(loop, context):
            # Phones drop sockets abruptly when they sleep; the Windows proactor loop logs a
            # harmless traceback for each one. Swallow just those.
            if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
                return
            loop.default_exception_handler(context)

        loop.set_exception_handler(quiet_resets)
        app["pump"] = asyncio.create_task(board.pump())

    async def stop_pump(app):
        app["pump"].cancel()
        source.stop()

    app.on_startup.append(start_pump)
    app.on_cleanup.append(stop_pump)

    print("\n  Race Control Board%s" % ("  [DEMO MODE]" if args.demo else ""))
    print("  Open on this PC:       http://localhost:%d" % args.port)
    for a in lan_addresses():
        print("  Open on phone/tablet:  http://%s:%d" % (a, args.port))
    print()
    web.run_app(app, host=args.host, port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    sys.exit(main())
