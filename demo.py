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
    "Kendall Ross", "Logan Weiss", "You (demo)",
]
NUMS = ["3", "7", "11", "14", "19", "22", "24", "31", "42", "48", "5", "9", "12", "17", "20", "01", "33", "55", "77", "88", "99"]
CAR_SLOTS = 64
ME = len(NAMES)  # the demo "you" is the last car
SHIFT = {"idleRpm": 1100, "slFirst": 6800, "slShift": 7600, "slLast": 7900, "slBlink": 8000, "redline": 8200}
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
    "Speed": ("GPS vehicle speed", "m/s"), "RPM": ("Engine rpm", "revs/min"), "Gear": ("-1=reverse 0=neutral 1..n=current gear", ""),
    "Throttle": ("0=off throttle to 1=full throttle", "%"), "Brake": ("0=brake released to 1=max pedal force", "%"),
    "Clutch": ("0=disengaged to 1=fully engaged", "%"), "SteeringWheelAngle": ("Steering wheel angle", "rad"),
    "FuelLevel": ("Liters of fuel remaining", "l"), "FuelLevelPct": ("Percent fuel remaining", "%"),
    "FuelUsePerHour": ("Engine fuel used instantaneous", "kg/h"),
    "Lap": ("Laps started count", ""), "LapCompleted": ("Laps completed count", ""), "LapDistPct": ("Percentage distance around lap", "%"),
    "LapCurrentLapTime": ("Estimate of players current lap time", "s"), "LapLastLapTime": ("Players last lap time", "s"),
    "LapBestLapTime": ("Players best lap time", "s"), "LapDeltaToBestLap": ("Delta time for best lap", "s"),
    "LapDeltaToBestLap_OK": ("Delta time for best lap is valid", ""),
    "PlayerCarPosition": ("Players position in race", ""), "PlayerCarClassPosition": ("Players class position in race", ""),
    "PlayerCarMyIncidentCount": ("Incident count for this driver", ""), "PlayerCarTeamIncidentCount": ("Incident count for team", ""),
    "OnPitRoad": ("Is the player car on pit road between the cones", ""), "IsOnTrack": ("1=Car on track physics running", ""),
    "PlayerTrackSurface": ("Players car track surface type", "irsdk_TrkLoc"),
    "WaterTemp": ("Engine coolant temp", "C"), "OilTemp": ("Engine oil temperature", "C"), "OilPress": ("Engine oil pressure", "bar"),
    "Voltage": ("Engine voltage", "V"), "dcBrakeBias": ("In car brake bias adjustment", "%"),
    "EngineWarnings": ("Bitfield for warning lights", "irsdk_EngineWarnings"),
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
        si = {
            "WeekendInfo": {"TrackDisplayName": "Demo Raceway", "TrackConfigName": "Grand Prix",
                            "EventType": "Race", "SessionID": 1, "SubSessionID": 424242},
            "DriverInfo": {"DriverCarIdx": ME, "DriverUserID": 100000 + ME, "Drivers": drivers,
                           "DriverCarIdleRPM": SHIFT["idleRpm"], "DriverCarRedLine": SHIFT["redline"],
                           "DriverCarSLFirstRPM": SHIFT["slFirst"], "DriverCarSLShiftRPM": SHIFT["slShift"],
                           "DriverCarSLLastRPM": SHIFT["slLast"], "DriverCarSLBlinkRPM": SHIFT["slBlink"],
                           "DriverCarFuelMaxLtr": 100.0, "DriverCarEstLapTime": 89.0},
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
            "CamCarIdx": self.cam_idx, "PlayerCarIdx": ME, "AirTemp": 22.4, "TrackTempCrew": 31.7,
            "CarIdxPosition": pos, "CarIdxClassPosition": cpos, "CarIdxLap": lap, "CarIdxLapCompleted": lapc,
            "CarIdxLapDistPct": pct, "CarIdxOnPitRoad": pit, "CarIdxTrackSurface": surf,
            "CarIdxLastLapTime": last, "CarIdxBestLapTime": best, "CarIdxSessionFlags": cflags,
        }
        values.update(self._my_car(t, lap, lapc, pct, pit, surf, last, best, pos, cpos))
        return {n: values[n] for n in names if n in values}

    def _my_car(self, t, lap, lapc, pct, pit, surf, last, best, pos, cpos):
        """Synthesized dash data for the demo player's car."""
        me = self.cars[ME - 1]
        p = pct[ME]

        def speed_at(x):  # three fast straights and three slow corners per lap, m/s
            return 26 + 44 * ((0.5 + 0.5 * math.cos(2 * math.pi * 3 * x)) ** 0.7)

        in_pit = pit[ME]
        speed = 22.0 if in_pit else speed_at(p)
        dv = speed_at(p + 0.004) - speed
        gears = [0, 20, 30, 40, 50, 60, 99]
        gear = next(g for g in range(1, 7) if speed < gears[g])
        span = (speed - gears[gear - 1]) / (gears[gear] - gears[gear - 1])
        rpm = min(SHIFT["redline"], 4600 + span * 3500)
        throttle = 0.35 if in_pit else (1.0 if dv > -0.05 else max(0.0, 0.3 + dv))
        brake = 0.0 if in_pit or dv > -0.4 else min(1.0, -dv / 3)
        dist = lapc[ME] + p
        fuel = max(2.0, 62.0 - 2.55 * dist - 0.12 * math.sin(lapc[ME]))
        return {
            "Speed": round(speed, 2), "RPM": round(rpm), "Gear": gear, "Throttle": round(throttle, 3),
            "Brake": round(brake, 3), "Clutch": 1.0, "SteeringWheelAngle": round(0.9 * math.sin(2 * math.pi * 3 * p + 1.2), 3),
            "FuelLevel": round(fuel, 3), "FuelLevelPct": round(fuel / 100.0, 4), "FuelUsePerHour": round(30 + 60 * throttle, 1),
            "Lap": lap[ME], "LapCompleted": lapc[ME], "LapDistPct": p,
            "LapCurrentLapTime": round(p * me["lap_time"], 3), "LapLastLapTime": last[ME], "LapBestLapTime": best[ME],
            "LapDeltaToBestLap": round(0.45 * math.sin(t / 9), 3), "LapDeltaToBestLap_OK": lapc[ME] > 0,
            "PlayerCarPosition": pos[ME], "PlayerCarClassPosition": cpos[ME],
            "PlayerCarMyIncidentCount": me["inc"], "PlayerCarTeamIncidentCount": me["inc"],
            "OnPitRoad": in_pit, "IsOnTrack": True, "PlayerTrackSurface": surf[ME],
            "WaterTemp": round(88 + 3 * math.sin(t / 40), 1), "OilTemp": round(101 + 4 * math.sin(t / 55), 1),
            "OilPress": 4.8, "Voltage": 13.8, "dcBrakeBias": 54.5,
            "EngineWarnings": 0x10 if in_pit else 0,
        }

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
