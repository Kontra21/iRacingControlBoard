"""Fake iRacing session for trying the board without the sim running (python server.py --demo)."""
import logging
import math
import random
import re
import time

from irsdk import CAM_SPECIAL_TARGETS, CommandError, build_session_digest

log = logging.getLogger("demo")

NAMES = [
    "Alex Morgan", "Sam Rivera", "Jordan Blake", "Casey Nguyen", "Taylor Brooks", "Riley Chen",
    "Jamie Fox", "Morgan Patel", "Drew Kowalski", "Quinn O'Neill", "Avery Schmidt", "Reese Tanaka",
    "Parker Dubois", "Rowan Silva", "Skyler Novak", "Emerson Hale", "Finley Park", "Hayden Cruz",
    "Kendall Ross", "Logan Weiss",
]
NUMS = ["3", "7", "11", "14", "19", "22", "24", "31", "42", "48", "5", "9", "12", "17", "20", "01", "33", "55", "77", "88"]
CAR_SLOTS = 64
FLAG_GREEN, FLAG_YELLOW, FLAG_YELLOW_WAVING = 0x4, 0x8, 0x100
FLAG_CAUTION, FLAG_CAUTION_WAVING, FLAG_BLACK, FLAG_DQ, FLAG_FURLED = 0x4000, 0x8000, 0x10000, 0x20000, 0x80000

VARS = {
    "SessionTime": ("Seconds since session start", "s"),
    "SessionTimeRemain": ("Seconds left till session ends", "s"),
    "SessionLapsRemainEx": ("New improved laps left till session ends", ""),
    "SessionNum": ("Session number", ""),
    "SessionState": ("Session state", "irsdk_SessionState"),
    "SessionFlags": ("Session flags", "irsdk_Flags"),
    "PaceMode": ("Are we pacing or not", "irsdk_PaceMode"),
    "CamCarIdx": ("Active camera's focus car index", ""),
    "PlayerCarIdx": ("Players carIdx", ""),
    "AirTemp": ("Temperature of air at start/finish line", "C"),
    "TrackTempCrew": ("Temperature of track measured by crew around track", "C"),
    "CarIdxPosition": ("Cars position in race by car index", ""),
    "CarIdxClassPosition": ("Cars class position in race by car index", ""),
    "CarIdxLap": ("Laps started by car index", ""),
    "CarIdxLapCompleted": ("Laps completed by car index", ""),
    "CarIdxLapDistPct": ("Percentage distance around lap by car index", "%"),
    "CarIdxOnPitRoad": ("On pit road between the cones by car index", ""),
    "CarIdxTrackSurface": ("Track surface type by car index", "irsdk_TrkLoc"),
    "CarIdxLastLapTime": ("Cars last lap time", "s"),
    "CarIdxBestLapTime": ("Cars best lap time", "s"),
    "CarIdxSessionFlags": ("Session flags for each player", "irsdk_Flags"),
}


class DemoSource:
    kind = "demo"

    def __init__(self):
        rnd = random.Random(7)
        self.t0 = time.time()
        self.connected = True
        self.cam_idx = 1
        self.caution_at = None
        self.car_flags = {}
        self.cars = []
        for i, name in enumerate(NAMES):
            gtp = i < 6
            self.cars.append({
                "idx": i + 1,
                "lap_time": (78.0 if gtp else 88.0) + rnd.uniform(0, 2.5),
                "offset": -0.012 * i,
                "noise": rnd.random() * 10,
                "inc": rnd.choice([0, 0, 0, 1, 2, 2, 4, 5]),
                "class": "GTP" if gtp else "GT3",
            })
        self.session_version = 0
        self._last_inc_bump = time.time()
        self._rnd = rnd
        self._rebuild_session()

    def start(self):
        pass

    def stop(self):
        pass

    def status(self):
        return {"mode": "demo", "connected": True}

    def var_list(self):
        return [{"name": n, "desc": d, "unit": u, "count": CAR_SLOTS if n.startswith("CarIdx") else 1, "type": "demo"}
                for n, (d, u) in sorted(VARS.items())]

    def _rebuild_session(self):
        drivers = [{"CarIdx": 0, "UserName": "Pace Car", "CarNumber": "0", "CarIsPaceCar": 1,
                    "CarClassColor": 0xFFFFFF, "CarScreenNameShort": "Safety Car"}]
        for c, name, num in zip(self.cars, NAMES, NUMS):
            gtp = c["class"] == "GTP"
            drivers.append({
                "CarIdx": c["idx"], "UserName": name, "CarNumber": num, "TeamName": name,
                "AbbrevName": name.split()[1] + ", " + name[0], "Initials": name[0] + name.split()[1][0],
                "UserID": 100000 + c["idx"], "CarScreenNameShort": "Porsche 963" if gtp else "BMW M4 GT3",
                "CarClassID": 1 if gtp else 2, "CarClassShortName": c["class"],
                "CarClassColor": 0xFF5888 if gtp else 0x33CEFF,
                "IRating": 1500 + (c["idx"] * 137) % 3000, "LicString": "A 3.21", "LicColor": 0x0153DB,
                "CurDriverIncidentCount": c["inc"], "TeamIncidentCount": c["inc"],
            })
        drivers.append({"CarIdx": 21, "UserName": "League Admin", "CarNumber": "", "IsSpectator": 1})
        si = {
            "WeekendInfo": {"TrackDisplayName": "Demo Raceway", "TrackConfigName": "Grand Prix",
                            "EventType": "Race", "SessionID": 1, "SubSessionID": 424242},
            "DriverInfo": {"DriverCarIdx": 21, "Drivers": drivers},
            "SessionInfo": {"Sessions": [
                {"SessionNum": 0, "SessionType": "Practice", "SessionName": "PRACTICE", "SessionLaps": "unlimited"},
                {"SessionNum": 1, "SessionType": "Lone Qualify", "SessionName": "QUALIFY", "SessionLaps": 2},
                {"SessionNum": 2, "SessionType": "Race", "SessionName": "RACE", "SessionLaps": 40},
            ]},
            "CameraInfo": {"Groups": [{"GroupNum": n + 1, "GroupName": g} for n, g in enumerate(
                ["Nose", "Gearbox", "Roll Bar", "LF Susp", "Gyro", "Cockpit", "Scenic", "TV1", "TV2", "TV3",
                 "Pit Lane", "Blimp", "Chopper", "Chase", "Far Chase", "Rear Chase"])]},
        }
        self.session = build_session_digest(si)
        self.session_version += 1

    def get(self, names):
        now = time.time()
        t = now - self.t0
        if now - self._last_inc_bump > 25:
            self._last_inc_bump = now
            self._rnd.choice(self.cars)["inc"] += self._rnd.choice([1, 2, 4])
            self._rebuild_session()

        def arr(fill=0):
            return [fill] * CAR_SLOTS

        pos, cpos, lap, lapc, pct = arr(), arr(), arr(-1), arr(-1), arr(-1.0)
        pit, surf, last, best, cflags = arr(False), arr(-1), arr(-1.0), arr(-1.0), arr(0)
        dists = []
        for c in self.cars:
            i = c["idx"]
            wobble = 0.004 * math.sin(t / 7 + c["noise"])
            d = max(0.0, t / c["lap_time"] + c["offset"] + wobble)
            dists.append((d, c))
            lapc[i] = int(d)
            lap[i] = int(d) + 1
            pct[i] = round(d % 1, 4)
            in_pit = lapc[i] > 0 and lapc[i] % 14 == i % 14 and pct[i] > 0.92
            pit[i] = in_pit
            surf[i] = 1 if in_pit and pct[i] > 0.97 else 2 if in_pit else 3
            if lapc[i] > 0:
                last[i] = round(c["lap_time"] + 0.6 * math.sin(lapc[i] + c["noise"]), 3)
                best[i] = round(c["lap_time"] - 0.35, 3)
            cflags[i] = self.car_flags.get(i, 0)
        dists.sort(key=lambda x: -x[0])
        per_class = {}
        for p, (_, c) in enumerate(dists, 1):
            pos[c["idx"]] = p
            per_class[c["class"]] = per_class.get(c["class"], 0) + 1
            cpos[c["idx"]] = per_class[c["class"]]

        flags = FLAG_GREEN
        if self.caution_at is not None:
            since = now - self.caution_at
            if since > 90:
                self.caution_at = None
            else:
                flags = FLAG_CAUTION | FLAG_YELLOW | (FLAG_CAUTION_WAVING | FLAG_YELLOW_WAVING if since < 10 else 0)
        leader_lap = lapc[dists[0][1]["idx"]]
        values = {
            "SessionTime": round(t, 3), "SessionTimeRemain": max(0.0, 3600 - t),
            "SessionLapsRemainEx": max(0, 40 - leader_lap), "SessionNum": 2, "SessionState": 4,
            "SessionFlags": flags, "PaceMode": 4 if self.caution_at is None else 2,
            "CamCarIdx": self.cam_idx, "PlayerCarIdx": 21, "AirTemp": 22.4, "TrackTempCrew": 31.7,
            "CarIdxPosition": pos, "CarIdxClassPosition": cpos, "CarIdxLap": lap, "CarIdxLapCompleted": lapc,
            "CarIdxLapDistPct": pct, "CarIdxOnPitRoad": pit, "CarIdxTrackSurface": surf,
            "CarIdxLastLapTime": last, "CarIdxBestLapTime": best, "CarIdxSessionFlags": cflags,
        }
        return {n: values[n] for n in names if n in values}

    # reactions to commands, so buttons visibly do something in demo mode
    def idx_for_num(self, num):
        num = str(num).lstrip("#")
        for d in self.session["drivers"]:
            if d["num"] == num:
                return d["idx"]
        return None

    def on_chat(self, text):
        m = re.match(r"!(\w+)\s*(?:#(\S+))?", text)
        if not m:
            return
        cmd, num = m.group(1).lower(), m.group(2)
        idx = self.idx_for_num(num) if num else None
        if cmd == "yellow":
            self.caution_at = time.time()
        elif cmd == "black" and idx is not None:
            self.car_flags[idx] = FLAG_BLACK
        elif cmd == "dq" and idx is not None:
            self.car_flags[idx] = FLAG_DQ
        elif cmd == "clear" and idx is not None:
            self.car_flags.pop(idx, None)
        elif cmd == "clearall":
            self.car_flags.clear()


class DemoCommands:
    """Accepts every command, logs it, and pokes the demo session."""

    def __init__(self, source):
        self.source = source

    def broadcast(self, cmd, var1=0, var2=0, var3=None):
        log.info("[demo] broadcast %s %s %s %s", cmd, var1, var2, var3)

    def cam_switch_num(self, car, group=0, camera=0):
        car = str(car).strip().lower()
        if car in CAM_SPECIAL_TARGETS:
            return
        idx = self.source.idx_for_num(car)
        if idx is None:
            raise CommandError("No car #%s in session" % car)
        self.source.cam_idx = idx

    def cam_switch_pos(self, position, group=0, camera=0):
        pass

    def replay_speed(self, speed, slow=False):
        pass

    def replay_search(self, mode):
        pass

    def chat_macro(self, n):
        pass

    def chat(self, text, opts):
        time.sleep(0.15)  # feel like the real thing
        self.source.on_chat(text)
