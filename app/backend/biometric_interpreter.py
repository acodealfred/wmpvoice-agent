import logging
from dataclasses import dataclass
from typing import Literal

from aiohttp import web

# Configure logging at module level
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger("biometric_interpreter")
logger.setLevel(logging.INFO)


@dataclass
class StressResult:
    state: Literal["stressed", "relaxed", "normal"]
    confidence: float
    trend: Literal["increasing", "decreasing", "stable"]
    blink_rate_change_percent: float | None = None


class BiometricInterpreter:
    BR_THRESHOLD_HIGH_LIMIT = 35
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

        logger.info(
            f"[STRESS] ★ Baseline: {self._baseline_blink_rate}, Current: {blink_rate}, Change: {blink_rate_change_percent}%"
        )

        if self._baseline_blink_rate > 0:
            if blink_rate_change_percent > 30:
                state = "stressed"
                excess = blink_rate_change_percent - 30
                confidence = min(0.95, 0.7 + (excess / 100))
                logger.info(
                    f"[STRESS] ★★★ DETECTED STRESSED: change={blink_rate_change_percent}%, excess={excess}%"
                )
            elif blink_rate_change_percent < -30:
                state = "relaxed"
                deficit = abs(blink_rate_change_percent) - 30
                confidence = min(0.95, 0.7 + (deficit / 100))
                logger.info(
                    f"[STRESS] ★★★ DETECTED RELAXED: change={blink_rate_change_percent}%, deficit={deficit}%"
                )
            else:
                state = "normal"
                confidence = 0.75
                logger.info(
                    f"[STRESS] ★★★ DETECTED NORMAL: change={blink_rate_change_percent}% (within +/-30%)"
                )
        else:
            if blink_rate > self.BR_THRESHOLD_HIGH_LIMIT:
                state = "stressed"
                excess = blink_rate - self.BR_THRESHOLD_HIGH_LIMIT
                confidence = min(0.95, 0.7 + (excess / 20))
                logger.info(
                    f"[STRESS] ★★★ DETECTED STRESSED: blink_rate={blink_rate}, threshold={self.BR_THRESHOLD_HIGH_LIMIT}"
                )
            elif blink_rate < self.BR_THRESHOLD_LOW_LIMIT:
                state = "relaxed"
                deficit = self.BR_THRESHOLD_LOW_LIMIT - blink_rate
                confidence = min(0.95, 0.7 + (deficit / 20))
                logger.info(
                    f"[STRESS] ★★★ DETECTED RELAXED: blink_rate={blink_rate}, threshold={self.BR_THRESHOLD_LOW_LIMIT}"
                )
            else:
                state = "normal"
                confidence = 0.75
                logger.info(f"[STRESS] ★★★ DETECTED NORMAL: blink_rate={blink_rate}")

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
            f"[STRESS] ★★★ Request received: blink_rate={blink_rate}, baseline_blink_rate={baseline_blink_rate}"
        )

        if blink_rate is None:
            return web.json_response({"error": "No blink_rate provided"}, status=400)

        interpreter = get_biometric_interpreter()

        if baseline_blink_rate is not None and baseline_blink_rate > 0:
            logger.info(
                f"[STRESS] ★ Setting baseline blink rate to: {baseline_blink_rate}"
            )
            interpreter.set_baseline_blink_rate(baseline_blink_rate)

        result = interpreter.analyze_blink_rate(blink_rate)

        logger.info(
            f"[STRESS] ★★★ RESULT: state={result.state}, blink_rate={blink_rate}, baseline={interpreter._baseline_blink_rate}, change_percent={result.blink_rate_change_percent}"
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
