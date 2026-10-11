"""NavEvolve Talk (hackathon, Milestone 6): Gemini grounded in stored memories.

Two small helpers used by server.py:
  verify(obs_id, goal)       is `goal` visible in that stored JPEG?  → {visible, reason}
  answer(question, memories) free-form reply grounded ONLY in the memories passed in

Both reuse perception.py's client/model settings (brain/.env); no new config.
"""

from __future__ import annotations

import json

from google.genai import types

import db
import perception

VERIFY_PROMPT = (
    'Look at this first-person image. Is "{goal}" clearly visible in it? '
    'Answer with JSON only: {{"visible": true or false, "reason": "one short sentence citing visible evidence"}}. '
    "Do not guess beyond what is visible."
)

ANSWER_PROMPT = (
    "You are the NavEvolve Agent, an embodied agent that explores indoor spaces and remembers places. "
    "Answer the user's question in one to three sentences, using ONLY the memories listed below "
    "(each is a real stored observation with its description). If the memories do not contain "
    "the answer, say you have no memory of it. Never invent places, objects or locations.\n\n"
    "Memories:\n{memories}\n\nUser: {question}"
)


INTENT_PROMPT = (
    "Classify the user's instruction to an embodied indoor agent. Return JSON only: "
    '{{"intent": one of "navigate" (go to / find / stand next to something), "have_seen" '
    '(asks whether the agent has seen something), "list_places" (asks which places it remembers), '
    '"describe_here" (asks what it sees now), "stop", or "chat"; '
    '"target": the object or place named, as a short noun phrase, or "" }}. '
    "Never invent a target that is not in the text.\n\nInstruction: {text}"
)

INTENTS = {"navigate", "have_seen", "list_places", "describe_here", "stop", "chat"}


def intent(text: str) -> dict:
    client = perception._client()
    response = client.models.generate_content(
        model=perception.VLM_MODEL,
        contents=INTENT_PROMPT.format(text=text.replace("{", "(").replace("}", ")")),
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.0),
    )
    result = json.loads(response.text)
    kind = str(result.get("intent", "chat"))
    return {"intent": kind if kind in INTENTS else "chat", "target": str(result.get("target", ""))[:100],
            "model": perception.VLM_MODEL}


def verify(obs_id: str, goal: str) -> dict:
    jpeg = db.get_observation(obs_id, with_image=True)
    if jpeg is None:
        raise ValueError("observation not found")
    client = perception._client()
    response = client.models.generate_content(
        model=perception.VLM_MODEL,
        contents=[types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"),
                  VERIFY_PROMPT.format(goal=goal.replace('"', "'"))],
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.1),
    )
    result = json.loads(response.text)
    return {"visible": bool(result.get("visible")), "reason": str(result.get("reason", ""))[:300],
            "model": perception.VLM_MODEL}


def answer(question: str, memories: list[dict]) -> dict:
    lines = []
    for m in memories[:12]:
        text = m.get("description_text") or m.get("summary") or ""
        if text:
            lines.append(f"- [{m.get('id', '?')}] {text[:400]}")
    client = perception._client()
    response = client.models.generate_content(
        model=perception.VLM_MODEL,
        contents=ANSWER_PROMPT.format(memories="\n".join(lines) or "(none)", question=question),
        config=types.GenerateContentConfig(temperature=0.3),
    )
    return {"answer": response.text.strip(), "model": perception.VLM_MODEL, "memories_used": len(lines)}
