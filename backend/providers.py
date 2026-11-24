"""Model calls. One function per provider, all returning the same shape.

The app itself only uses Claude. The other two providers exist so the eval can
back "model-agnostic" with numbers and so the AI labelling isn't Claude-only.
"""
from __future__ import annotations

import base64
import copy
import json
import os
import time
from typing import List

import anthropic
import httpx

from .config import MODELS

_anthropic_client = None


def _claude() -> anthropic.AsyncAnthropic:
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.AsyncAnthropic(max_retries=2, timeout=180.0)
    return _anthropic_client


class ModelError(Exception):
    """A model call failed in a way the caller should show, not crash on."""


def cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    m = MODELS[model]
    return round(tokens_in / 1e6 * m["in"] + tokens_out / 1e6 * m["out"], 5)


async def call_model(model: str, system: str, parts: list, schema: dict, effort: str = "medium") -> dict:
    """parts: list of {"text": str} or {"jpeg": bytes}, in order.
    Returns {"data": dict, "tokens_in", "tokens_out", "cost_usd", "latency_s"}."""
    provider = MODELS[model]["provider"]
    t0 = time.time()
    if provider == "anthropic":
        data, tin, tout = await _call_claude(model, system, parts, schema, effort)
    elif provider == "openai":
        data, tin, tout = await _call_openai(model, system, parts, schema)
    elif provider == "gemini":
        data, tin, tout = await _call_gemini(model, system, parts, schema)
    else:  # pragma: no cover
        raise ModelError(f"Unknown provider for {model}")
    return {"data": data, "tokens_in": tin, "tokens_out": tout, "cost_usd": cost_usd(model, tin, tout),
            "latency_s": round(time.time() - t0, 1)}


async def _call_claude(model, system, parts, schema, effort):
    content = []
    for p in parts:
        if "text" in p:
            content.append({"type": "text", "text": p["text"]})
        else:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                         "data": base64.standard_b64encode(p["jpeg"]).decode()}})
    try:
        # Structured output: the reply must be JSON that fits the schema, so the model
        # can only answer with parts and damage types from our lists.
        resp = await _claude().messages.create(
            model=model,
            max_tokens=12000,
            system=system,
            messages=[{"role": "user", "content": content}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.RateLimitError as e:
        raise ModelError("The model is rate limited right now.") from e
    except anthropic.APIStatusError as e:
        raise ModelError(f"The model returned an error ({e.status_code}).") from e
    except anthropic.APIConnectionError as e:
        raise ModelError("Couldn't reach the model.") from e
    tin, tout = resp.usage.input_tokens, resp.usage.output_tokens
    if resp.stop_reason == "refusal":
        raise ModelError("The model declined to assess these photos.")
    if resp.stop_reason == "max_tokens":
        raise ModelError("The model's answer was cut off.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text), tin, tout
    except json.JSONDecodeError as e:
        raise ModelError("The model's answer wasn't valid JSON.") from e


async def _call_openai(model, system, parts, schema):
    content = []
    for p in parts:
        if "text" in p:
            content.append({"type": "text", "text": p["text"]})
        else:
            content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.standard_b64encode(p["jpeg"]).decode()}})
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "assessment", "strict": True, "schema": schema}},
    }
    r = await _post("https://api.openai.com/v1/chat/completions", body, {"Authorization": "Bearer " + os.environ.get("OPENAI_API_KEY", "")})
    try:
        msg = r["choices"][0]["message"]
        if msg.get("refusal"):
            raise ModelError("The model declined to assess these photos.")
        return json.loads(msg["content"]), r["usage"]["prompt_tokens"], r["usage"]["completion_tokens"]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
        raise ModelError("Unexpected answer from the OpenAI model.") from e


def _gemini_schema(schema: dict) -> dict:
    """Gemini's schema dialect has no additionalProperties."""
    s = copy.deepcopy(schema)

    def walk(node):
        if isinstance(node, dict):
            node.pop("additionalProperties", None)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(s)
    return s


async def _call_gemini(model, system, parts, schema):
    gparts = []
    for p in parts:
        if "text" in p:
            gparts.append({"text": p["text"]})
        else:
            gparts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.standard_b64encode(p["jpeg"]).decode()}})
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": gparts}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": _gemini_schema(schema)},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    r = await _post(url, body, {"x-goog-api-key": os.environ.get("GEMINI_API_KEY", "")})
    try:
        text = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"] if not p.get("thought"))
        u = r.get("usageMetadata", {})
        tout = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
        return json.loads(text), u.get("promptTokenCount", 0), tout
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
        raise ModelError("Unexpected answer from the Gemini model.") from e


async def _post(url: str, body: dict, headers: dict) -> dict:
    last = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=240.0) as c:
                r = await c.post(url, json=body, headers=headers)
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                await _sleep(4 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise ModelError(f"The model returned an error ({r.status_code}): {r.text[:200]}")
            return r.json()
        except httpx.HTTPError as e:
            last = e
            await _sleep(3)
    raise ModelError("Couldn't reach the model.") from last


async def _sleep(s: float) -> None:
    import asyncio

    await asyncio.sleep(s)
