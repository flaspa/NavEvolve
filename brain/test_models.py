import numpy as np

import fake_models as m

J = b"imgbytes"


def test_embed():
    a, b, c = m.embed_text("red sofa"), m.embed_text("sofa in room"), m.embed_text("kitchen fridge")
    assert a.dtype == np.float32 and abs(np.linalg.norm(a) - 1) < 1e-5
    assert a @ b > a @ c
    assert np.allclose(m.embed_image(J), m.embed_image(J))


def test_vlm():
    assert m.describe(J) == m.describe(J)
    objs = m.list_objects(J)
    assert objs and len(objs[0]["bbox"]) == 4
    v = m.verify(J, objs[0]["name"])
    assert v["visible"] and v["bbox"]
    assert not m.verify(J, "zzz")["visible"]
    assert m.choose([J], "sofa", "", ["a", "b"])["choice"] == 0
