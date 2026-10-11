"""2-D grid world implementing the Body interface. Frame jpeg = b"FAKE:" + json."""
import json
import math
from collections import deque

from agent import _fwd

MAP = ["####################",
       "#........#.........#",
       "#........#.........#",
       "#..................#",
       "#........#.........#",
       "####.#####.#########",
       "#........#.........#",
       "#........#.........#",
       "####################"]


class FakeBody:
    def __init__(self, objects, start=(1, 1), heading=0.0, on_frame=None):
        self.objects = objects  # {name: (x, z)}
        self.x, self.z, self.h = start[0], start[1], heading
        self.seen, self.on_frame, self.n = set(), on_frame, 0
        self.thoughts = []
        self._see()

    def free(self, x, z):
        return 0 <= z < len(MAP) and 0 <= x < len(MAP[0]) and MAP[z][x] == "."

    def _see(self):
        for dz in range(-3, 4):
            for dx in range(-3, 4):
                if self.free(self.x + dx, self.z + dz):
                    self.seen.add((self.x + dx, self.z + dz))

    def _pose(self):
        return {"x": float(self.x), "y": 1.5, "z": float(self.z), "headingDeg": self.h % 360, "pitchDeg": 0}

    def _bfs(self, goal):
        prev, q = {(self.x, self.z): None}, deque([(self.x, self.z)])
        while q:
            c = q.popleft()
            if c == goal:
                path = []
                while c:
                    path.append(c); c = prev[c]
                return path[::-1]
            for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c[0] + d[0], c[1] + d[1])
                if n not in prev and self.free(*n):
                    prev[n] = c; q.append(n)

    def _view(self):
        vis, near = [], None
        fx, fz = _fwd(self.h)
        for name, (ox, oz) in self.objects.items():
            d = math.hypot(ox - self.x, oz - self.z)
            if d > 5:
                continue
            if d > 0 and (fx * (ox - self.x) + fz * (oz - self.z)) / d < math.cos(math.radians(45)):
                continue
            steps = int(d * 4)
            if any(not self.free(round(self.x + (ox - self.x) * i / steps), round(self.z + (oz - self.z) * i / steps))
                   for i in range(1, steps)):
                continue
            vis.append({"name": name, "position": [ox, 0.5, oz]})
            near = d if near is None else min(near, d)
        return vis, near

    async def capture(self, headings=1):
        frames = []
        for _ in range(headings):
            vis, near = self._view()
            self.n += 1
            f = {"frameId": f"f{self.n}", "pose": self._pose(), "rangeM": near,
                 "jpeg": b"FAKE:" + json.dumps({"objects": vis}).encode()}
            self.h += 360 / headings
            frames.append(f)
            if self.on_frame:
                self.on_frame(f)
        self._see()
        return frames

    async def goto(self, x, z, stop_within=0.3):
        g = (round(x), round(z))
        path = self._bfs(g) if self.free(*g) else None
        if not path:
            return {"status": "unreachable", "pose": self._pose(), "pathLength": 0, "path": []}
        if len(path) > 1:
            self.h = math.degrees(math.atan2(path[-1][0] - path[-2][0], path[-1][1] - path[-2][1]))
        for self.x, self.z in path:
            self._see()
        return {"status": "arrived", "pose": self._pose(), "pathLength": len(path) - 1, "path": [list(p) for p in path]}

    async def turn(self, deg):
        self.h += deg
        return {"pose": self._pose()}

    async def face(self, x, z):
        if (x, z) != (self.x, self.z):
            self.h = math.degrees(math.atan2(x - self.x, z - self.z))
        return {"pose": self._pose()}

    async def pose(self):
        return {"pose": self._pose()}

    async def frontiers(self):
        out = []
        for (x, z) in self.seen:
            size = sum(1 for d in ((1, 0), (-1, 0), (0, 1), (0, -1))
                       if self.free(x + d[0], z + d[1]) and (x + d[0], z + d[1]) not in self.seen)
            if size and self._bfs((x, z)):
                out.append({"x": float(x), "z": float(z), "size": size})
        out.sort(key=lambda f: -f["size"])
        return {"frontiers": out[:8], "coverage": len(self.seen) / 100}

    async def reset(self, x, z, heading_deg):
        self.x, self.z, self.h = round(x), round(z), heading_deg
        self.seen = set(); self._see()
        return {"pose": self._pose()}

    async def thought(self, phase, text, frame_id=None):
        self.thoughts.append((phase, text))

    async def memory(self, objects):
        pass

    async def halt(self):
        pass
