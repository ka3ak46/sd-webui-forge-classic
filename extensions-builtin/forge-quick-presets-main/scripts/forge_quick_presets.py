import json
import os
import shutil
import tempfile
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from modules import paths, script_callbacks


EXTENSION_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRESETS_DIR = os.path.join(EXTENSION_ROOT, "presets")
PRESETS_FILE = os.path.join(PRESETS_DIR, "user_presets.json")
MAX_PRESET_BACKUPS = 3
FORGE_BASELINE_FIELDS = {
    "txt2img": {
        "txt2img_sampling": ("{preset}_t2i_sampler", "Sampling Method"),
        "txt2img_scheduler": ("{preset}_t2i_scheduler", "Schedule Type"),
        "txt2img_steps": ("{preset}_t2i_step", "Steps"),
        "txt2img_width": ("{preset}_t2i_width", "Width"),
        "txt2img_height": ("{preset}_t2i_height", "Height"),
        "txt2img_cfg_scale": ("{preset}_t2i_cfg", "CFG Scale"),
        "txt2img_distilled_cfg_scale": ("{preset}_t2i_dcfg", "Distilled CFG Scale"),
        "txt2img_batch_size": ("{preset}_t2i_batch_size", "Batch Size"),
        "txt2img_hr_second_pass_steps": ("{preset}_t2i_hr_step", "Hires steps"),
        "txt2img_hr_cfg": ("{preset}_t2i_hr_cfg", "Hires CFG Scale"),
        "txt2img_hr_distilled_cfg_scale": ("{preset}_t2i_hr_dcfg", "Hires Distilled CFG Scale"),
    },
    "img2img": {
        "img2img_sampling": ("{preset}_i2i_sampler", "Sampling Method"),
        "img2img_scheduler": ("{preset}_i2i_scheduler", "Schedule Type"),
        "img2img_steps": ("{preset}_i2i_step", "Steps"),
        "img2img_width": ("{preset}_i2i_width", "Width"),
        "img2img_height": ("{preset}_i2i_height", "Height"),
        "img2img_cfg_scale": ("{preset}_i2i_cfg", "CFG Scale"),
        "img2img_distilled_cfg_scale": ("{preset}_i2i_dcfg", "Distilled CFG Scale"),
        "img2img_batch_size": ("{preset}_i2i_batch_size", "Batch Size"),
    },
}


class PresetPayload(BaseModel):
    name: str
    tab: str | None = None
    base_preset: str | None = None
    fields: dict[str, Any]
    notes: str | None = None


class RenamePayload(BaseModel):
    old_name: str
    new_name: str
    tab: str | None = None


def _preset_key(tab: str | None, name: str) -> str:
    return f"{tab or 'txt2img'}::{name}"


def _now() -> int:
    return int(time.time())


def _ensure_store() -> None:
    os.makedirs(PRESETS_DIR, exist_ok=True)
    if not os.path.exists(PRESETS_FILE):
        _write_store({"version": 1, "presets": {}})


def _read_store() -> dict[str, Any]:
    _ensure_store()
    try:
        data = _read_json_file(PRESETS_FILE)
    except json.JSONDecodeError:
        broken_name = f"{PRESETS_FILE}.broken-{_now()}"
        os.replace(PRESETS_FILE, broken_name)
        data = {"version": 1, "presets": {}}
        _write_store(data)

    if not isinstance(data, dict):
        return {"version": 1, "presets": {}}

    presets = data.get("presets")
    if not isinstance(presets, dict):
        data["presets"] = {}

    data["presets"] = _migrate_presets(data["presets"])
    data.setdefault("version", 1)
    return data


def _migrate_presets(presets: dict[str, Any]) -> dict[str, Any]:
    migrated: dict[str, Any] = {}
    changed = False

    for key, preset in presets.items():
        if not isinstance(preset, dict):
            continue

        name = preset.get("name") or key.split("::", 1)[-1]
        tab = preset.get("tab") or "txt2img"
        new_key = _preset_key(tab, name)

        if key != new_key:
            changed = True

        migrated[new_key] = {
            **preset,
            "name": name,
            "tab": tab,
        }

    if changed:
        data = {"version": 1, "presets": migrated}
        _write_store(data)

    return migrated


def _read_json_file(filename: str) -> dict[str, Any]:
    last_error: json.JSONDecodeError | UnicodeError | None = None
    for encoding in ("utf-8", "utf-8-sig", "utf-16"):
        try:
            with open(filename, "r", encoding=encoding) as handle:
                return json.load(handle)
        except (json.JSONDecodeError, UnicodeError) as exc:
            last_error = exc

    if isinstance(last_error, json.JSONDecodeError):
        raise last_error

    raise json.JSONDecodeError("Unable to decode JSON file.", "", 0)


def _backup_store() -> None:
    if not os.path.exists(PRESETS_FILE) or os.path.getsize(PRESETS_FILE) == 0:
        return

    backup_name = os.path.join(PRESETS_DIR, f"user_presets.json.bak-{_now()}")
    shutil.copy2(PRESETS_FILE, backup_name)
    _prune_preset_backups()


def _prune_preset_backups() -> None:
    try:
        backups = [
            os.path.join(PRESETS_DIR, name)
            for name in os.listdir(PRESETS_DIR)
            if name.startswith("user_presets.json.bak-")
        ]
    except FileNotFoundError:
        return

    backups.sort(key=lambda filename: os.path.getmtime(filename), reverse=True)
    for filename in backups[MAX_PRESET_BACKUPS:]:
        try:
            os.remove(filename)
        except OSError:
            pass


def _write_store(data: dict[str, Any]) -> None:
    os.makedirs(PRESETS_DIR, exist_ok=True)
    _backup_store()
    fd, tmp_name = tempfile.mkstemp(prefix="user_presets.", suffix=".json", dir=PRESETS_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp_name, PRESETS_FILE)
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)


def _clean_name(name: str) -> str:
    value = (name or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Preset name is empty.")
    if len(value) > 120:
        raise HTTPException(status_code=400, detail="Preset name is too long.")
    return value


def _clean_key(key: str) -> str:
    value = (key or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Preset key is empty.")
    if len(value) > 150:
        raise HTTPException(status_code=400, detail="Preset key is too long.")
    return value


def _list_presets() -> dict[str, Any]:
    data = _read_store()
    presets = data["presets"]
    return {
        "version": data.get("version", 1),
        "script_choices": _script_choices(),
        "presets": [
            {
                "key": key,
                "name": name,
                "tab": preset.get("tab"),
                "base_preset": preset.get("base_preset"),
                "field_count": len(preset.get("fields", {})),
                "updated_at": preset.get("updated_at"),
                "created_at": preset.get("created_at"),
                "notes": preset.get("notes"),
            }
            for key, preset in sorted(presets.items(), key=lambda item: (item[1].get("tab", ""), item[1].get("name", item[0]).lower()))
            for name in [preset.get("name") or key.split("::", 1)[-1]]
        ],
    }


def _script_choices() -> dict[str, list[str]]:
    try:
        from modules import scripts

        return {
            "txt2img": ["None", *getattr(scripts.scripts_txt2img, "titles", [])],
            "img2img": ["None", *getattr(scripts.scripts_img2img, "titles", [])],
        }
    except Exception:
        return {"txt2img": ["None"], "img2img": ["None"]}


def _forge_baseline(preset: str, tab: str) -> dict[str, Any]:
    try:
        from modules import shared
    except Exception:
        return {"fields": {}}

    clean_preset = (preset or "").strip()
    clean_tab = tab if tab in FORGE_BASELINE_FIELDS else "txt2img"
    if not clean_preset:
        clean_preset = getattr(shared.opts, "forge_preset", "")

    fields: dict[str, Any] = {}
    for field_id, (option_template, label) in FORGE_BASELINE_FIELDS[clean_tab].items():
        option_name = option_template.format(preset=clean_preset)
        if not hasattr(shared.opts, option_name):
            continue

        value = getattr(shared.opts, option_name)
        if isinstance(value, (int, float)) and value <= 0:
            continue

        fields[field_id] = {
            "id": field_id,
            "label": label,
            "value": value,
        }

    return {"preset": clean_preset, "tab": clean_tab, "fields": fields}


def quick_presets_api(_: Any, app: FastAPI) -> None:
    @app.get("/forge-quick-presets/list")
    def list_presets():
        return _list_presets()

    @app.get("/forge-quick-presets/baseline/{preset}/{tab}")
    def forge_baseline(preset: str, tab: str):
        return _forge_baseline(preset, tab)

    @app.get("/forge-quick-presets/get/{key:path}")
    def get_preset(key: str):
        clean_key = _clean_key(key)
        presets = _read_store()["presets"]
        if clean_key not in presets:
            raise HTTPException(status_code=404, detail="Preset was not found.")
        return presets[clean_key]

    @app.post("/forge-quick-presets/save")
    def save_preset(payload: PresetPayload):
        clean_name = _clean_name(payload.name)
        if not isinstance(payload.fields, dict) or not payload.fields:
            raise HTTPException(status_code=400, detail="Preset has no changed fields.")

        data = _read_store()
        key = _preset_key(payload.tab, clean_name)
        existing = data["presets"].get(key, {})
        created_at = existing.get("created_at", _now())
        data["presets"][key] = {
            "name": clean_name,
            "tab": payload.tab or "txt2img",
            "base_preset": payload.base_preset,
            "fields": payload.fields,
            "notes": payload.notes,
            "created_at": created_at,
            "updated_at": _now(),
        }
        _write_store(data)
        return _list_presets()

    @app.post("/forge-quick-presets/delete/{key:path}")
    def delete_preset(key: str):
        clean_key = _clean_key(key)
        data = _read_store()
        data["presets"].pop(clean_key, None)
        _write_store(data)
        return _list_presets()

    @app.post("/forge-quick-presets/rename")
    def rename_preset(payload: RenamePayload):
        old_name = _clean_name(payload.old_name)
        new_name = _clean_name(payload.new_name)
        old_key = _preset_key(payload.tab, old_name)
        new_key = _preset_key(payload.tab, new_name)
        data = _read_store()
        if old_key not in data["presets"]:
            raise HTTPException(status_code=404, detail="Preset was not found.")
        if new_key in data["presets"] and new_key != old_key:
            raise HTTPException(status_code=409, detail="Preset with this name already exists.")

        preset = data["presets"].pop(old_key)
        preset["name"] = new_name
        preset["tab"] = payload.tab or preset.get("tab") or "txt2img"
        preset["updated_at"] = _now()
        data["presets"][new_key] = preset
        _write_store(data)
        return _list_presets()


script_callbacks.on_app_started(quick_presets_api, name="forge_quick_presets_api")
