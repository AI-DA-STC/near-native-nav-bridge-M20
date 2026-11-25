"""The Roboflow workflow "Carton Interior Mask Preview" on the Aloha's photos of the box's inside, for inspect_box.py:
run_carton_workflow(photos, out_dir) -> [PhotoResult per photo]

The workflow (workspace test001-78x0i, workflow carton-interior-mask-preview-1795512106163, on Roboflow's serverless
API) takes one input, image, and no parameters. It segments the carton's interior (model carton-interior-segmentation,
at most one mask), blanks everything outside it, and only if it found the interior looks for the objects in it (model
carton-contents-detection: bottle, screwdriver, tape_roll, warning_taped_box, wire), drawn boxed with their class and
confidence. Per photo it answers interior_count, predictions and output_image (both null without an interior), plus
masked_interior and interior_masks, which the request leaves out: they are not used, and are most of the answer.

All the photos go in one request, with up to RETRIES retries on network errors, timeouts, 429 and 5xx. The key is
ROBOFLOW_API_KEY, from the environment, else from the package root's .env (gitignored), and goes only in the
Authorization header. Plain urllib: the ROS 2 Foxy laptop's python3 is 3.8, and inference-sdk needs 3.10 or later."""

import base64
import binascii
import http.client
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, NamedTuple, Optional, Sequence

API_URL = "https://serverless.roboflow.com"
WORKSPACE = "test001-78x0i"
WORKFLOW_ID = "carton-interior-mask-preview-1795512106163"
KEY_VAR = "ROBOFLOW_API_KEY"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
OUTPUTS = ("interior_count", "predictions", "output_image")  # the workflow's outputs read here
EXCLUDED = ("masked_interior", "interior_masks")  # and the ones left out of its answer
TIMEOUT_S = 30.0  # per try; two 2048 x 1536 photos took 13 s
RETRIES = 2  # tries after the first
BACKOFF_S = 1.0  # before the first retry, doubled before each next one


class WorkflowError(RuntimeError):
    """The workflow could not be run on the photos"""


class MissingKeyError(WorkflowError):
    """No ROBOFLOW_API_KEY in the environment or .env"""


class WorkflowRequestError(WorkflowError):
    """The request failed: refused (4xx other than 429, at once), or still failing after the retries. status is the
    last HTTP status, None when there was no answer at all"""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class WorkflowResponseError(WorkflowError):
    """The answer does not have this workflow's outputs"""


class Found(NamedTuple):
    name: str  # the contents model's class
    confidence: float


class PhotoResult(NamedTuple):
    """What the workflow saw in one photo"""
    interior: bool  # it found the carton's interior; without it no objects are looked for
    objects: List[Found]  # most confident first
    image: Optional[Path]  # the photo with the objects drawn (output_image), saved; None without an interior


def api_key():
    """ROBOFLOW_API_KEY from the environment, else from the package root's .env"""
    key = os.environ.get(KEY_VAR, "").strip()
    if not key and ENV_FILE.is_file():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):]
            name, sep, value = line.partition("=")
            if sep and name.strip() == KEY_VAR:
                key = value.strip().strip("'\"")
    if not key:
        raise MissingKeyError(f"no {KEY_VAR}: export it, or put {KEY_VAR}=<key> in {ENV_FILE} "
                              "(the key is at app.roboflow.com/settings/api)")
    return key


def run_carton_workflow(photos: Sequence[Path], out_dir: Path, timeout: float = TIMEOUT_S,
                        retries: int = RETRIES) -> List[PhotoResult]:
    """Runs the workflow on the photos (JPEG or PNG files), in one request, and says what it saw in each, in order.
    The drawing of each photo where it found the interior is saved in out_dir as <photo's name>_annotated.jpg.
    Raises MissingKeyError, WorkflowRequestError or WorkflowResponseError (all WorkflowError)."""
    photos = [Path(photo) for photo in photos]
    if not photos:
        raise ValueError("no photos")
    outputs = _post(photos, api_key(), timeout, retries)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return [_read(photo, entry, out_dir) for photo, entry in zip(photos, outputs)]


def _post(photos, key, timeout, retries):
    """The workflow's outputs for the photos: one dict per photo, in order"""
    body = json.dumps({
        "inputs": {"image": [{"type": "base64", "value": base64.b64encode(photo.read_bytes()).decode("ascii")}
                             for photo in photos]},
        "excluded_fields": list(EXCLUDED),
    }).encode()
    request = urllib.request.Request(f"{API_URL}/{WORKSPACE}/workflows/{WORKFLOW_ID}", data=body, method="POST",
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    failure, status = "", None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                answer = response.read()
            break
        except urllib.error.HTTPError as e:
            failure, status = f"HTTP {e.code} {_reason(e)}".strip(), e.code
            if e.code != 429 and e.code < 500:
                raise WorkflowRequestError(f"the workflow refused the request: {failure}", status) from None
        except (http.client.HTTPException, OSError) as e:  # OSError: URLError, timeouts, dropped connections
            failure, status = str(getattr(e, "reason", None) or e) or type(e).__name__, None
    else:
        raise WorkflowRequestError(f"no answer from the workflow after {retries + 1} tries: {failure}", status)
    try:
        outputs = json.loads(answer)["outputs"]
    except (ValueError, KeyError, TypeError):
        raise WorkflowResponseError("the answer is not JSON with outputs") from None
    if not isinstance(outputs, list) or len(outputs) != len(photos):
        raise WorkflowResponseError(f"{len(outputs) if isinstance(outputs, list) else 'no'} results "
                                    f"for {len(photos)} photos")
    return outputs


def _reason(error):
    """The message in an HTTP error's body, short"""
    try:
        text = error.read(2000).decode("utf-8", "replace")
    except OSError:
        return str(error.reason or "")
    try:
        text = str(json.loads(text).get("message") or text)
    except (ValueError, AttributeError):
        pass
    return " ".join(text.split())[:300]


def _read(photo, entry, out_dir):
    """One photo's PhotoResult from its outputs; saves its drawing"""
    if not isinstance(entry, dict) or any(name not in entry for name in OUTPUTS):
        raise WorkflowResponseError(f"the result for {photo.name} has "
                                    f"{', '.join(sorted(entry)) if isinstance(entry, dict) else 'no outputs'}, "
                                    f"not {', '.join(OUTPUTS)}")
    count = entry["interior_count"]
    if isinstance(count, bool) or not isinstance(count, (int, float)):
        raise WorkflowResponseError(f"interior_count for {photo.name} is {count!r}, not a number")
    objects = []
    for found in ((entry["predictions"] or {}).get("predictions") or []):
        try:
            objects.append(Found(str(found["class"]), float(found["confidence"])))
        except (KeyError, TypeError, ValueError):
            raise WorkflowResponseError(f"a prediction for {photo.name} has no class or confidence") from None
    objects.sort(key=lambda found: -found.confidence)
    image, drawn = None, entry["output_image"]
    if drawn:
        try:
            data = base64.b64decode(drawn["value"], validate=True)
        except (KeyError, TypeError, binascii.Error):
            raise WorkflowResponseError(f"output_image for {photo.name} is not a base64 image") from None
        suffix = ".png" if data.startswith(b"\x89PNG") else ".jpg"
        image = out_dir / f"{photo.stem}_annotated{suffix}"
        image.write_bytes(data)
    return PhotoResult(count > 0, objects, image)
