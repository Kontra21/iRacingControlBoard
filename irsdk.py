"""Minimal iRacing SDK access for Windows.

- IRacingSource: reads live telemetry + session info from iRacing's shared memory.
- IRacingCommands: sends SDK broadcast messages (camera, replay, chat macros) and
  types chat text into the sim (used for admin commands like "!waveby #12").

Only the Python standard library + PyYAML are used; everything else is ctypes.
"""
import ctypes
import logging
import math
import re
import struct
import sys
import threading
import time

import yaml

try:
    from yaml import CSafeLoader as _YamlLoader
except ImportError:  # pragma: no cover
    from yaml import SafeLoader as _YamlLoader

log = logging.getLogger("irsdk")

IS_WINDOWS = sys.platform == "win32"

MEMMAP_NAME = "Local\\IRSDKMemMapFileName"
DATA_EVENT_NAME = "Local\\IRSDKDataValidEvent"
BROADCAST_MSG_NAME = "IRSDK_BROADCASTMSG"

# irsdk_header: ver, status, tickRate, sessionInfoUpdate, sessionInfoLen, sessionInfoOffset,
#               numVars, varHeaderOffset, numBuf, bufLen, pad[2], then varBuf[4]
HEADER_FMT = "<10i2i"
HEADER_TOTAL = 48 + 4 * 16
VARBUF_FMT = "<4i"  # tickCount, bufOffset, pad[2]
VARHDR_FMT = "<iii?3x32s64s32s"  # type, offset, count, countAsTime, name, desc, unit
VARHDR_SIZE = struct.calcsize(VARHDR_FMT)  # 144

STATUS_CONNECTED = 1

# irsdk_VarType -> struct format char
VAR_TYPES = {0: "c", 1: "?", 2: "i", 3: "I", 4: "f", 5: "d"}
VAR_TYPE_NAMES = {0: "char", 1: "bool", 2: "int", 3: "bitfield", 4: "float", 5: "double"}

# Undefined cp1252 bytes iRacing sometimes emits in names
_YAML_FIX = bytes.maketrans(b"\x81\x8d\x8f\x90\x9d", b"     ")
_NAME_FIELDS = re.compile(
    r"^(\s*(?:UserName|TeamName|AbbrevName|Initials|DriverSetupName|CarDesignStr|"
    r"CarNumberDesignStr|HelmetDesignStr|SuitDesignStr|ClubName|DivisionName): )(.*)$",
    re.MULTILINE,
)


class CommandError(Exception):
    pass


# --------------------------------------------------------------------------------------
# Session info digest (shared by the real and demo sources)
# --------------------------------------------------------------------------------------

def _hex_color(v, default=0xFFFFFF):
    try:
        return "#%06x" % (int(v) & 0xFFFFFF)
    except (TypeError, ValueError):
        return "#%06x" % default


def build_session_digest(si):
    """Reduce iRacing's big session-info YAML to what the UI needs."""
    si = si or {}
    wi = si.get("WeekendInfo") or {}
    di = si.get("DriverInfo") or {}
    drivers = []
    for d in di.get("Drivers") or []:
        drivers.append({
            "idx": d.get("CarIdx"),
            "num": str(d.get("CarNumber", "")),
            "name": str(d.get("UserName", "")),
            "abbrev": str(d.get("AbbrevName", "") or ""),
            "initials": str(d.get("Initials", "") or ""),
            "team": str(d.get("TeamName", "") or ""),
            "userId": d.get("UserID"),
            "car": d.get("CarScreenNameShort") or d.get("CarScreenName") or "",
            "classId": d.get("CarClassID"),
            "classShort": str(d.get("CarClassShortName") or ""),
            "classColor": _hex_color(d.get("CarClassColor")),
            "irating": d.get("IRating"),
            "license": d.get("LicString") or "",
            "licColor": _hex_color(d.get("LicColor"), 0x888888),
            "inc": d.get("CurDriverIncidentCount"),
            "teamInc": d.get("TeamIncidentCount"),
            "spectator": bool(d.get("IsSpectator")),
            "paceCar": bool(d.get("CarIsPaceCar")),
        })
    sessions = []
    for s in (si.get("SessionInfo") or {}).get("Sessions") or []:
        sessions.append({
            "num": s.get("SessionNum"),
            "type": s.get("SessionType"),
            "name": s.get("SessionName"),
            "laps": s.get("SessionLaps"),
            "time": s.get("SessionTime"),
        })
    cameras = [
        {"num": g.get("GroupNum"), "name": g.get("GroupName")}
        for g in (si.get("CameraInfo") or {}).get("Groups") or []
    ]
    player = {
        "idx": di.get("DriverCarIdx"),
        "userId": di.get("DriverUserID"),
        "idleRpm": di.get("DriverCarIdleRPM"),
        "redline": di.get("DriverCarRedLine"),
        "slFirst": di.get("DriverCarSLFirstRPM"),
        "slShift": di.get("DriverCarSLShiftRPM"),
        "slLast": di.get("DriverCarSLLastRPM"),
        "slBlink": di.get("DriverCarSLBlinkRPM"),
        "fuelMax": di.get("DriverCarFuelMaxLtr"),
        "estLap": di.get("DriverCarEstLapTime"),
    }
    return {
        "player": player,
        "track": wi.get("TrackDisplayName") or "",
        "trackConfig": wi.get("TrackConfigName") or "",
        "eventType": wi.get("EventType") or "",
        "sessionId": wi.get("SessionID"),
        "subSessionId": wi.get("SubSessionID"),
        "playerIdx": di.get("DriverCarIdx"),
        "drivers": drivers,
        "sessions": sessions,
        "cameras": cameras,
    }


def _clean(v):
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 4)
    return v


# --------------------------------------------------------------------------------------
# Win32 plumbing
# --------------------------------------------------------------------------------------

if IS_WINDOWS:
    from ctypes import wintypes as wt

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    u32 = ctypes.WinDLL("user32", use_last_error=True)

    FILE_MAP_READ = 0x0004
    SYNCHRONIZE = 0x00100000

    k32.OpenFileMappingW.argtypes = [wt.DWORD, wt.BOOL, wt.LPCWSTR]
    k32.OpenFileMappingW.restype = wt.HANDLE
    k32.MapViewOfFile.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_size_t]
    k32.MapViewOfFile.restype = ctypes.c_void_p
    k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    k32.CloseHandle.argtypes = [wt.HANDLE]
    k32.VirtualQuery.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    k32.VirtualQuery.restype = ctypes.c_size_t
    k32.OpenEventW.argtypes = [wt.DWORD, wt.BOOL, wt.LPCWSTR]
    k32.OpenEventW.restype = wt.HANDLE
    k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
    k32.WaitForSingleObject.restype = wt.DWORD

    class _MBI(ctypes.Structure):
        _fields_ = [
            ("BaseAddress", ctypes.c_void_p),
            ("AllocationBase", ctypes.c_void_p),
            ("AllocationProtect", wt.DWORD),
            ("PartitionId", wt.WORD),
            ("RegionSize", ctypes.c_size_t),
            ("State", wt.DWORD),
            ("Protect", wt.DWORD),
            ("Type", wt.DWORD),
        ]

    u32.RegisterWindowMessageW.argtypes = [wt.LPCWSTR]
    u32.RegisterWindowMessageW.restype = wt.UINT
    u32.SendNotifyMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    u32.SendNotifyMessageW.restype = wt.BOOL
    u32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    u32.PostMessageW.restype = wt.BOOL
    u32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
    u32.FindWindowW.restype = wt.HWND
    u32.GetForegroundWindow.restype = wt.HWND
    u32.SetForegroundWindow.argtypes = [wt.HWND]
    u32.SetForegroundWindow.restype = wt.BOOL
    u32.IsIconic.argtypes = [wt.HWND]
    u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
    u32.VkKeyScanW.argtypes = [wt.WCHAR]
    u32.VkKeyScanW.restype = ctypes.c_short
    u32.MapVirtualKeyW.argtypes = [wt.UINT, wt.UINT]
    u32.MapVirtualKeyW.restype = wt.UINT

    ULONG_PTR = ctypes.c_size_t

    class _KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                    ("time", wt.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class _MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                    ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class _HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]

    class _INPUT(ctypes.Structure):
        _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]

    u32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
    u32.SendInput.restype = wt.UINT


# --------------------------------------------------------------------------------------
# Telemetry reader
# --------------------------------------------------------------------------------------

class IRacingSource:
    kind = "iracing"

    def __init__(self):
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="irsdk-reader", daemon=True)
        self._h = self._addr = self._event = None
        self._size = 0
        self._vars = {}
        self._var_key = None
        self._buf = None
        self._tick = -1
        self._tick_changed_at = 0.0
        self._si_update = None
        self.connected = False
        self.session = None
        self.session_version = 0

    # public API -------------------------------------------------------------------
    def start(self):
        if not IS_WINDOWS:
            log.warning("Not on Windows: iRacing telemetry unavailable (use --demo)")
            return
        self._thread.start()

    def stop(self):
        self._stop.set()

    def status(self):
        return {"mode": "iracing", "connected": self.connected}

    def var_list(self):
        with self._lock:
            return [
                {"name": n, "desc": v[3], "unit": v[4], "count": v[2], "type": VAR_TYPE_NAMES.get(v[0], "?")}
                for n, v in sorted(self._vars.items())
            ]

    def get(self, names):
        with self._lock:
            buf, vars_ = self._buf, self._vars
        if buf is None or not self.connected:
            return {}
        out = {}
        for n in names:
            v = vars_.get(n)
            if v is None:
                continue
            vtype, off, count = v[0], v[1], v[2]
            try:
                if vtype == 0:
                    out[n] = buf[off:off + count].split(b"\0", 1)[0].decode("cp1252", "replace")
                    continue
                vals = struct.unpack_from("<%d%s" % (count, VAR_TYPES[vtype]), buf, off)
            except (struct.error, KeyError):
                continue
            out[n] = _clean(vals[0]) if count == 1 else [_clean(x) for x in vals]
        return out

    # internals --------------------------------------------------------------------
    def _open(self):
        h = k32.OpenFileMappingW(FILE_MAP_READ, False, MEMMAP_NAME)
        if not h:
            return False
        addr = k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
        if not addr:
            k32.CloseHandle(h)
            return False
        mbi = _MBI()
        k32.VirtualQuery(addr, ctypes.byref(mbi), ctypes.sizeof(mbi))
        self._h, self._addr, self._size = h, addr, mbi.RegionSize
        self._event = k32.OpenEventW(SYNCHRONIZE, False, DATA_EVENT_NAME) or None
        self._var_key = None
        self._si_update = None
        self._tick_changed_at = time.monotonic()
        log.info("Opened iRacing shared memory (%d KB)", self._size // 1024)
        return True

    def _close(self):
        if self._addr:
            k32.UnmapViewOfFile(self._addr)
        if self._h:
            k32.CloseHandle(self._h)
        if self._event:
            k32.CloseHandle(self._event)
        self._h = self._addr = self._event = None
        self._set_disconnected()

    def _set_disconnected(self):
        if self.connected:
            log.info("iRacing disconnected")
        with self._lock:
            self.connected = False
            self._buf = None
            self._tick = -1
            if self.session is not None:
                self.session = None
                self.session_version += 1

    def _read(self, off, n):
        if off < 0 or n < 0 or off + n > self._size:
            raise ValueError("read outside shared memory (%d+%d > %d)" % (off, n, self._size))
        return ctypes.string_at(self._addr + off, n)

    def _run(self):
        while not self._stop.is_set():
            if not self._addr and not self._open():
                self._stop.wait(1.0)
                continue
            try:
                if not self._poll():
                    self._close()
                    self._stop.wait(1.0)
            except Exception:
                log.exception("Telemetry read failed")
                self._close()
                self._stop.wait(1.0)

    def _poll(self):
        """Read one update. Returns False when the mapping should be reopened."""
        if self._event:
            k32.WaitForSingleObject(self._event, 200)
        else:
            time.sleep(1 / 60)

        raw = self._read(0, HEADER_TOTAL)
        (_ver, status, _rate, si_update, si_len, si_off,
         num_vars, vh_off, num_buf, buf_len, _p1, _p2) = struct.unpack_from(HEADER_FMT, raw)
        if not status & STATUS_CONNECTED:
            self._set_disconnected()
            return False

        if self._var_key != (num_vars, vh_off):
            self._parse_var_headers(num_vars, vh_off)

        bufs = [struct.unpack_from(VARBUF_FMT, raw, 48 + 16 * i) for i in range(max(1, min(num_buf, 4)))]
        bi = max(range(len(bufs)), key=lambda i: bufs[i][0])
        tick, off = bufs[bi][0], bufs[bi][1]

        now = time.monotonic()
        if tick == self._tick:
            # Sim frozen/gone: drop the mapping so a restarted sim is picked up cleanly
            return now - self._tick_changed_at < 5.0
        data = self._read(off, buf_len)
        tick_after = struct.unpack_from("<i", self._read(48 + 16 * bi, 4))[0]
        if tick_after != tick:
            return True  # buffer was rewritten mid-copy; try again next frame

        with self._lock:
            self._buf = data
            self._tick = tick
        self._tick_changed_at = now

        if si_update != self._si_update:
            self._si_update = si_update
            self._parse_session_info(si_off, si_len)
        if not self.connected:
            log.info("iRacing connected")
            self.connected = True
        return True

    def _parse_var_headers(self, num_vars, vh_off):
        raw = self._read(vh_off, num_vars * VARHDR_SIZE)
        vars_ = {}
        for i in range(num_vars):
            vtype, off, count, _cat, name, desc, unit = struct.unpack_from(VARHDR_FMT, raw, i * VARHDR_SIZE)
            dec = lambda b: b.split(b"\0", 1)[0].decode("cp1252", "replace")
            vars_[dec(name)] = (vtype, off, count, dec(desc), dec(unit))
        with self._lock:
            self._vars = vars_
        self._var_key = (num_vars, vh_off)
        log.info("Loaded %d telemetry variables", num_vars)

    def _parse_session_info(self, off, length):
        raw = self._read(off, length).split(b"\0", 1)[0]
        text = raw.translate(_YAML_FIX).decode("cp1252", "replace")

        def quote(m):
            val = m.group(2).strip()
            if val.startswith('"') and val.endswith('"'):
                return m.group(0)
            return m.group(1) + '"' + re.sub(r'(["\\])', r"\\\1", val) + '"'

        text = _NAME_FIELDS.sub(quote, text)
        try:
            si = yaml.load(text, Loader=_YamlLoader)
        except yaml.YAMLError:
            log.exception("Could not parse session info YAML")
            return
        digest = build_session_digest(si)
        with self._lock:
            self.session = digest
            self.session_version += 1


# --------------------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------------------

# irsdk_BroadcastMsg
BC_CAM_SWITCH_POS = 0
BC_CAM_SWITCH_NUM = 1
BC_CAM_SET_STATE = 2
BC_REPLAY_SET_PLAY_SPEED = 3
BC_REPLAY_SET_PLAY_POSITION = 4
BC_REPLAY_SEARCH = 5
BC_REPLAY_SET_STATE = 6
BC_RELOAD_TEXTURES = 7
BC_CHAT_COMMAND = 8
BC_PIT_COMMAND = 9
BC_TELEM_COMMAND = 10
BC_FFB_COMMAND = 11
BC_REPLAY_SEARCH_SESSION_TIME = 12
BC_VIDEO_CAPTURE = 13

CHAT_MACRO, CHAT_BEGIN, CHAT_REPLY, CHAT_CANCEL = 0, 1, 2, 3

REPLAY_SEARCH_MODES = {
    "toStart": 0, "toEnd": 1, "prevSession": 2, "nextSession": 3, "prevLap": 4,
    "nextLap": 5, "prevFrame": 6, "nextFrame": 7, "prevIncident": 8, "nextIncident": 9,
}

# irsdk_csMode: special "car numbers" for camera switching
CAM_SPECIAL_TARGETS = {"exiting": -1, "leader": -2, "incident": -3}

WM_KEYDOWN, WM_KEYUP, WM_CHAR = 0x0100, 0x0101, 0x0102
VK_RETURN, VK_SHIFT, VK_CONTROL, VK_MENU = 0x0D, 0x10, 0x11, 0x12
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0002, 0x0004
SW_RESTORE = 9


def _makelong(lo, hi):
    return (int(lo) & 0xFFFF) | ((int(hi) & 0xFFFF) << 16)


def pad_car_num(num_str):
    """Encode a car number string the way irsdk expects (preserves leading zeros)."""
    s = str(num_str).strip().lstrip("#")
    if not s.isdigit():
        raise CommandError("Invalid car number %r" % num_str)
    num = int(s)
    zeros = len(s) - len(s.lstrip("0")) if num else len(s) - 1
    if not zeros:
        return num
    places = 3 if num > 99 else 2 if num > 9 else 1
    return num + 1000 * (places + zeros)


class IRacingCommands:
    """Sends commands to the running sim. Methods are blocking; call from a worker thread."""

    def __init__(self):
        if not IS_WINDOWS:
            raise RuntimeError("iRacing commands require Windows")
        self._msg_id = u32.RegisterWindowMessageW(BROADCAST_MSG_NAME)
        self._lock = threading.Lock()

    # broadcast messages -------------------------------------------------------------
    def broadcast(self, cmd, var1=0, var2=0, var3=None):
        lparam = int(var2) if var3 is None else _makelong(var2, var3)
        if not u32.SendNotifyMessageW(0xFFFF, self._msg_id, _makelong(cmd, var1), lparam):
            raise CommandError("SendNotifyMessage failed (%d)" % ctypes.get_last_error())

    def cam_switch_num(self, car, group=0, camera=0):
        car = str(car).strip().lower()
        num = CAM_SPECIAL_TARGETS[car] if car in CAM_SPECIAL_TARGETS else pad_car_num(car)
        self.broadcast(BC_CAM_SWITCH_NUM, num, group, camera)

    def cam_switch_pos(self, position, group=0, camera=0):
        self.broadcast(BC_CAM_SWITCH_POS, position, group, camera)

    def replay_speed(self, speed, slow=False):
        self.broadcast(BC_REPLAY_SET_PLAY_SPEED, speed, 1 if slow else 0)

    def replay_search(self, mode):
        self.broadcast(BC_REPLAY_SEARCH, REPLAY_SEARCH_MODES[mode])

    def chat_macro(self, n):
        self.broadcast(BC_CHAT_COMMAND, CHAT_MACRO, int(n) - 1)

    # chat typing -------------------------------------------------------------------
    @staticmethod
    def _find_window():
        return u32.FindWindowW("SimWinClass", None) or u32.FindWindowW(None, "iRacing.com Simulator")

    @staticmethod
    def _send(events):
        arr = (_INPUT * len(events))()
        for i, (vk, scan, flags) in enumerate(events):
            arr[i].type = INPUT_KEYBOARD
            arr[i].u.ki = _KEYBDINPUT(vk, scan, flags, 0, 0)
        if u32.SendInput(len(events), arr, ctypes.sizeof(_INPUT)) != len(events):
            raise CommandError("SendInput was blocked (%d)" % ctypes.get_last_error())

    @classmethod
    def _key_events(cls, vk, up=False):
        return (vk, u32.MapVirtualKeyW(vk, 0), KEYEVENTF_KEYUP if up else 0)

    @classmethod
    def _type_char(cls, ch):
        scan = u32.VkKeyScanW(ch)
        if scan == -1 or ord(ch) > 0x7E:
            code = ord(ch)
            cls._send([(0, code, KEYEVENTF_UNICODE), (0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
            return
        vk, shift_state = scan & 0xFF, (scan >> 8) & 0xFF
        mods = [m for bit, m in ((1, VK_SHIFT), (2, VK_CONTROL), (4, VK_MENU)) if shift_state & bit]
        events = [cls._key_events(m) for m in mods]
        events += [cls._key_events(vk), cls._key_events(vk, up=True)]
        events += [cls._key_events(m, up=True) for m in reversed(mods)]
        cls._send(events)

    @classmethod
    def _focus(cls, hwnd):
        if u32.GetForegroundWindow() == hwnd:
            return
        if u32.IsIconic(hwnd):
            u32.ShowWindow(hwnd, SW_RESTORE)
        if not u32.SetForegroundWindow(hwnd):
            # Windows only lets the process that got the last input steal focus; an Alt tap counts.
            cls._send([cls._key_events(VK_MENU), cls._key_events(VK_MENU, up=True)])
            u32.SetForegroundWindow(hwnd)
        deadline = time.monotonic() + 0.5
        while u32.GetForegroundWindow() != hwnd:
            if time.monotonic() > deadline:
                raise CommandError("Could not bring iRacing to the foreground")
            time.sleep(0.02)

    def chat(self, text, opts):
        method = opts.get("chatMethod", "sendinput")
        open_delay = max(0, int(opts.get("chatOpenDelayMs", 120))) / 1000
        char_delay = max(0, int(opts.get("chatCharDelayMs", 8))) / 1000
        submit_delay = max(0, int(opts.get("chatSubmitDelayMs", 60))) / 1000

        with self._lock:
            hwnd = self._find_window()
            if not hwnd:
                raise CommandError("iRacing window not found - is the sim running?")
            prev = u32.GetForegroundWindow()
            if method == "sendinput":
                self._focus(hwnd)

            self.broadcast(BC_CHAT_COMMAND, CHAT_BEGIN)
            time.sleep(open_delay)
            try:
                for ch in text:
                    if method == "postmessage":
                        u32.PostMessageW(hwnd, WM_CHAR, ord(ch), 1)
                    else:
                        self._type_char(ch)
                    if char_delay:
                        time.sleep(char_delay)
                time.sleep(submit_delay)
                if method == "postmessage":
                    u32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 1)
                    u32.PostMessageW(hwnd, WM_CHAR, 13, 1)
                    u32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0xC0000001)
                else:
                    self._send([self._key_events(VK_RETURN), self._key_events(VK_RETURN, up=True)])
            except Exception:
                self.broadcast(BC_CHAT_COMMAND, CHAT_CANCEL)
                raise

            time.sleep(0.05)
            if method == "sendinput" and opts.get("restoreFocus", True) and prev and prev != hwnd:
                u32.SetForegroundWindow(prev)
