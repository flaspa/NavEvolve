import os

os.environ["NAVEVOLVE_FAKE_MODELS"] = "1"

import asyncio
import math

import mongomock
import pytest

import db
import agent_memory as memory
import models_impl as models

SCENE = "s1"


@pytest.fixture(autouse=True)
def mdb(monkeypatch):
    m = mongomock.MongoClient()["t"]
    monkeypatch.setattr(db, "get_db", lambda: m)
    return m


def add_obs(heading=0.0, x=0.0, z=0.0, rng=2.0, jpeg=b"img1"):
    pose = {"x": x, "y": 0.2, "z": z, "headingDeg": heading, "pitchDeg": 0}
    return db.insert_observation({"scene_id": SCENE, "pose": pose, "rangeM": rng,
                                  "camera_snapshot": {"position": [x, 1.5, z], "fov": 60, "aspect": 1.0}}, jpeg)


def test_ingest_fills_fields(mdb):
    oid = add_obs()
    asyncio.run(memory.ingest(oid))
    d = db.get_db()["observations"].find_one()
    assert d["ingest"] == "done" and d["desc"] and d["img_emb"] and d["desc_emb"]
    assert d["objects"] and all(o["emb"] for o in d["objects"])
    assert memory.known_objects(SCENE)


def test_position_math():
    obs = {"pose": {"x": 0, "y": 0, "z": 0, "headingDeg": 0}, "rangeM": 2,
           "camera_snapshot": {"position": [0, 1.5, 0], "fov": 90, "aspect": 1.0}}
    assert memory.object_position(obs, [0.4, 0, 0.6, 1]) == pytest.approx([0, 1.5, 2])  # heading 0 = +Z
    obs["pose"]["headingDeg"] = 90  # +heading = left; 90 faces +X
    assert memory.object_position(obs, [0.4, 0, 0.6, 1]) == pytest.approx([2, 1.5, 0])
    obs["pose"]["headingDeg"] = 0  # bbox at far right edge, 45 deg right of +Z => -X
    p = memory.object_position({**obs, "rangeM": None}, [1, 0, 1, 1])  # default 2 m
    assert p == pytest.approx([-2 * math.sin(math.atan(1)), 1.5, 2 * math.cos(math.atan(1))])


def test_merge(mdb):
    for _ in range(2):
        asyncio.run(memory.ingest(add_obs()))
    objs = list(mdb["objects"].find())
    assert all(o["sightings"] == 2 for o in objs)
    assert objs[0]["confidence"] == pytest.approx(1 - math.exp(-1))


def test_search_and_wipe(mdb):
    oid = add_obs()
    asyncio.run(memory.ingest(oid))
    name = models.list_objects(b"img1")[0]["name"]
    r = memory.search(SCENE, name)
    assert r and r[0]["verified"] and r[0]["obs_id"] == oid
    memory.wipe(SCENE)
    assert memory.known_objects(SCENE) == [] and memory.search(SCENE, name) == []


def test_search_survives_verify_timeout(mdb, monkeypatch):
    oid = add_obs()
    asyncio.run(memory.ingest(oid))
    name = models.list_objects(b"img1")[0]["name"]
    def hang(*a):
        raise TimeoutError("The read operation timed out")
    monkeypatch.setattr(memory.models, "verify", hang)
    r = memory.search(SCENE, name)
    assert r and not r[0]["verified"] and "TimeoutError" in r[0]["reason"]
