import json
import re
from datetime import datetime
import logging

class Scheduler:
    DUE_WINDOW_SECONDS = 600

    def __init__(self):
        self.logger = logging.getLogger("Scheduler")

    def _normalize_action(self, action):
        if not isinstance(action, dict):
            return None

        trigger_time = action.get("trigger_time")
        action_description = action.get("action_description")

        if not trigger_time or not action_description:
            return None

        target_user_id = action.get("target_user_id")
        if target_user_id is not None:
            target_user_id = str(target_user_id).strip()
            if not target_user_id:
                target_user_id = None

        target_user_name = action.get("target_user_name")
        if target_user_name is not None:
            target_user_name = str(target_user_name).strip() or None

        return {
            "trigger_time": str(trigger_time).strip(),
            "action_description": str(action_description).strip(),
            "target_user_id": target_user_id,
            "target_user_name": target_user_name,
        }

    def _find_json_array_candidates(self, memory_text):
        """Encuentra posibles arrays JSON tanto en bloque markdown como texto libre."""
        candidates = []

        # Prioridad: bloque ```json ... ```
        fenced = re.finditer(r"```json\s*(\[.*?\])\s*```", memory_text, re.DOTALL | re.IGNORECASE)
        for match in fenced:
            candidates.append(match.group(1))

        # Fallback: buscar arrays balanceados a nivel de texto
        starts = [idx for idx, ch in enumerate(memory_text) if ch == "["]
        for start in starts:
            depth = 0
            in_string = False
            escaped = False
            for idx in range(start, len(memory_text)):
                ch = memory_text[idx]
                if in_string:
                    if escaped:
                        escaped = False
                    elif ch == "\\":
                        escaped = True
                    elif ch == '"':
                        in_string = False
                    continue

                if ch == '"':
                    in_string = True
                elif ch == "[":
                    depth += 1
                elif ch == "]":
                    depth -= 1
                    if depth == 0:
                        candidates.append(memory_text[start:idx + 1])
                        break

        return candidates

    def _find_primary_json_block(self, memory_text):
        fenced_match = re.search(r"```json\s*(\[.*?\])\s*```", memory_text, re.DOTALL | re.IGNORECASE)
        if fenced_match:
            return {
                "json": fenced_match.group(1),
                "start": fenced_match.start(1),
                "end": fenced_match.end(1),
            }

        # Fallback a primer array parseable
        candidates = self._find_json_array_candidates(memory_text)
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, list):
                    start = memory_text.find(candidate)
                    if start != -1:
                        return {"json": candidate, "start": start, "end": start + len(candidate)}
            except json.JSONDecodeError:
                continue
        return None

    def _parse_trigger_datetime(self, trigger_time_str):
        formats = [
            "%Y-%m-%d %H:%M",
            "%Y-%m-%d %H:%M:%S",
            "%Y/%m/%d %H:%M",
            "%Y/%m/%d %H:%M:%S",
        ]
        for fmt in formats:
            try:
                return datetime.strptime(trigger_time_str, fmt)
            except ValueError:
                continue

        # Último intento: formato ISO parcial
        try:
            return datetime.fromisoformat(trigger_time_str)
        except ValueError:
            return None

    def build_action_key(self, action):
        action_description = str(action.get("action_description", "")).strip().lower()
        trigger_time = str(action.get("trigger_time", "")).strip()
        target_user_id = str(action.get("target_user_id", "") or "").strip()
        return f"{trigger_time}|{target_user_id}|{action_description}"

    def parse_scheduled_actions(self, memory_text):
        """
        Extrae el bloque JSON de acciones programadas del texto de la memoria.
        """
        if not memory_text:
            return []

        for json_str in self._find_json_array_candidates(memory_text):
            try:
                actions = json.loads(json_str)
                if not isinstance(actions, list):
                    continue

                normalized = []
                for action in actions:
                    safe_action = self._normalize_action(action)
                    if safe_action:
                        normalized.append(safe_action)
                return normalized
            except json.JSONDecodeError as e:
                self.logger.error(f"Error decodificando JSON de acciones: {e}")
                continue

        return []

    def check_due_actions(self, actions):
        """
        Filtra las acciones que deben ejecutarse ahora.
        """
        due_actions = []
        now = datetime.now()

        for action in actions:
            trigger_time_str = action.get("trigger_time")
            if not trigger_time_str:
                continue

            trigger_time = self._parse_trigger_datetime(str(trigger_time_str))
            if not trigger_time:
                self.logger.error(f"Formato de fecha inválido: {trigger_time_str}")
                continue

            time_diff = now - trigger_time
            if 0 <= time_diff.total_seconds() <= self.DUE_WINDOW_SECONDS:
                due_actions.append(action)

        return due_actions

    def remove_executed_actions_from_memory(self, memory_text, executed_actions):
        """
        Elimina acciones ya ejecutadas del bloque SCHEDULED_ACTIONS sin romper el resto del texto.
        """
        if not memory_text:
            return memory_text

        if not executed_actions:
            return memory_text

        block = self._find_primary_json_block(memory_text)
        if not block:
            return memory_text

        try:
            actions = json.loads(block["json"])
        except json.JSONDecodeError:
            return memory_text

        if not isinstance(actions, list):
            return memory_text

        executed_keys = {self.build_action_key(a) for a in executed_actions if isinstance(a, dict)}
        if not executed_keys:
            return memory_text

        remaining = []
        for action in actions:
            safe_action = self._normalize_action(action)
            if not safe_action:
                continue
            if self.build_action_key(safe_action) not in executed_keys:
                remaining.append(safe_action)

        new_json = json.dumps(remaining, ensure_ascii=False, indent=2)
        return memory_text[:block["start"]] + new_json + memory_text[block["end"]:]

scheduler = Scheduler()
