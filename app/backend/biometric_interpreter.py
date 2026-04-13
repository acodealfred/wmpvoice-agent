import logging
import os
from dataclasses import dataclass
from typing import Literal, Optional

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

try:
    from aiohttp import web
except ImportError:
    web = None


logger = logging.getLogger("biometric_interpreter")


@dataclass
class StressResult:
    state: Literal["stressed", "relaxed", "normal"]
    confidence: float
    trend: Literal["increasing", "decreasing", "stable"]
    blink_rate_change_percent: Optional[float] = None


class BiometricInterpreter:
    BR_THRESHOLD_HIGH_LIMIT = 50
    BR_THRESHOLD_LOW_LIMIT = 25

    def __init__(self):
        self._blink_rate_history: list[tuple[float, float]] = []
        self._last_state: str = "normal"
        self._baseline_blink_rate: float = 25.0

    def set_baseline_blink_rate(self, baseline: float):
        if baseline > 0:
            self._baseline_blink_rate = baseline

    def analyze_blink_rate(self, blink_rate: float) -> StressResult:
        self._blink_rate_history.append((blink_rate, 0.0))

        if len(self._blink_rate_history) > 12:
            self._blink_rate_history.pop(0)

        blink_rate_change_percent = 0.0
        if self._baseline_blink_rate > 0:
            blink_rate_change_percent = (
                (blink_rate - self._baseline_blink_rate) / self._baseline_blink_rate
            ) * 100

        state: Literal["stressed", "relaxed", "normal"]

        if self._baseline_blink_rate > 0:
            if blink_rate_change_percent > 50:
                state = "stressed"
                excess = blink_rate_change_percent - 50
                confidence = min(0.95, 0.7 + (excess / 100))
            elif blink_rate_change_percent < -50:
                state = "relaxed"
                deficit = abs(blink_rate_change_percent) - 50
                confidence = min(0.95, 0.7 + (deficit / 100))
            else:
                state = "normal"
                confidence = 0.75
        else:
            if blink_rate > self.BR_THRESHOLD_HIGH_LIMIT:
                state = "stressed"
                excess = blink_rate - self.BR_THRESHOLD_HIGH_LIMIT
                confidence = min(0.95, 0.7 + (excess / 20))
            elif blink_rate < self.BR_THRESHOLD_LOW_LIMIT:
                state = "relaxed"
                deficit = self.BR_THRESHOLD_LOW_LIMIT - blink_rate
                confidence = min(0.95, 0.7 + (deficit / 20))
            else:
                state = "normal"
                confidence = 0.75

        trend: Literal["increasing", "decreasing", "stable"]
        if len(self._blink_rate_history) >= 3:
            recent = self._blink_rate_history[-3:]
            avg_recent = sum(b for b, _ in recent) / len(recent)
            older = self._blink_rate_history[:-3]
            if len(older) > 0:
                avg_older = sum(b for b, _ in older) / len(older)
                diff = avg_recent - avg_older
                if diff > 3:
                    trend = "increasing"
                elif diff < -3:
                    trend = "decreasing"
                else:
                    trend = "stable"
            else:
                trend = "stable"
        else:
            trend = "stable"

        self._last_state = state

        return StressResult(
            state=state,
            confidence=confidence,
            trend=trend,
            blink_rate_change_percent=blink_rate_change_percent,
        )


_biometric_interpreter_instance: BiometricInterpreter | None = None


def get_biometric_interpreter() -> BiometricInterpreter:
    global _biometric_interpreter_instance
    if _biometric_interpreter_instance is None:
        _biometric_interpreter_instance = BiometricInterpreter()
    return _biometric_interpreter_instance


async def analyze_stress(request):
    try:
        data = await request.json()
        blink_rate = data.get("blink_rate")
        baseline_blink_rate = data.get("baseline_blink_rate")

        logger.info(
            f"[STRESS] Request: blink_rate={blink_rate}, baseline_blink_rate={baseline_blink_rate}"
        )

        if blink_rate is None:
            return web.json_response({"error": "No blink_rate provided"}, status=400)

        interpreter = get_biometric_interpreter()

        if baseline_blink_rate is not None and baseline_blink_rate > 0:
            logger.info(
                f"[STRESS] Setting baseline blink rate to: {baseline_blink_rate}"
            )
            interpreter.set_baseline_blink_rate(baseline_blink_rate)

        result = interpreter.analyze_blink_rate(blink_rate)

        logger.info(
            f"[STRESS] Result: state={result.state}, confidence={result.confidence}, trend={result.trend}, change_percent={result.blink_rate_change_percent}"
        )
        logger.info(
            f"[STRESS] Thresholds: HIGH={interpreter.BR_THRESHOLD_HIGH_LIMIT}, LOW={interpreter.BR_THRESHOLD_LOW_LIMIT}, baseline_used={interpreter._baseline_blink_rate}"
        )

        return web.json_response(
            {
                "state": result.state,
                "confidence": result.confidence,
                "trend": result.trend,
                "blink_rate_change_percent": result.blink_rate_change_percent,
            }
        )

    except Exception as e:
        logger.error(f"[STRESS] Error: {e}")
        return web.json_response({"error": str(e)}, status=500)
