import json
import math

import pytest

import agent
from fake_body import FakeBody

OBJS = {"lamp": (16, 1), "sofa": (2, 7)}


class Mem:
    def __init__(self):
        self.objs = {}

    def on_frame(self, f):
        for o in json.loads(f["jpeg"][5:])["objects"]:
            self.objs[o["name"]] = o

    def search(self, scene, q, k=3, verify=True):
        return [{**o, "verified": True} for o in self.objs.values() if o["name"] == q]

    def known_objects(self, scene):
        return list(self.objs.values())


class Models:
    @staticmethod
    def verify(jpeg, target):
        vis = any(o["name"] == target for o in json.loads(jpeg[5:])["objects"])
        return {"visible": vis, "bbox": None, "reason": "stub"}

    @staticmethod
    def choose(jpegs, goal, context, options):
        return {"choice": 0, "thought": "try " + options[0]}


@pytest.fixture
def mem(monkeypatch):
    m = Mem()
    monkeypatch.setattr(agent, "memory", m)
    monkeypatch.setattr(agent, "models", Models)
    return m


def run(mem, goal, **kw):
    body = FakeBody(OBJS, on_frame=mem.on_frame)
    return agent.find(body, "s", goal, **kw)


@pytest.mark.asyncio
async def test_explore_recall_fail(mem):
    a = await run(mem, "lamp")
    assert a["success"] and a["mode"] == "explore"
    b = await run(mem, "lamp")
    assert b["success"] and b["mode"] == "recall" and len(b["steps"]) < len(a["steps"])
    c = await run(mem, "unicorn", max_steps=25)
    assert not c["success"] and len(c["steps"]) <= 25


@pytest.mark.asyncio
async def test_recall_failure_falls_back_to_explore(mem, monkeypatch):
    def boom(*a):
        raise TimeoutError("The read operation timed out")
    monkeypatch.setattr(mem, "search", boom)
    a = await run(mem, "lamp")
    assert a["success"] and a["mode"] == "explore"


@pytest.mark.asyncio
async def test_verify_timeout_does_not_crash(mem, monkeypatch):
    def hang(*a):
        raise TimeoutError("The read operation timed out")
    monkeypatch.setattr(Models, "verify", staticmethod(hang))
    a = await run(mem, "lamp", max_steps=10)
    assert not a["success"] and len(a["steps"]) <= 10
