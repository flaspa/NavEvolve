"""Picks the model backend: fakes when NAVEVOLVE_FAKE_MODELS=1 (tests, offline), else real APIs."""
import os

if os.environ.get("NAVEVOLVE_FAKE_MODELS") == "1":
    from fake_models import *  # noqa: F401,F403
else:
    from models import *  # noqa: F401,F403
