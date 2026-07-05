"""HTTP route handler for face-emotion analysis."""
import logging

from aiohttp import web

from ciq.biometrics.rekognition import detect_face_details

logger = logging.getLogger("voicerag")


async def analyze_face(request):
    """POST /analyze — analyze face from image data using AWS Rekognition."""
    try:
        data = await request.json()
        image_data = data.get("image", "")

        if not image_data:
            return web.json_response({"error": "No image data provided"}, status=400)

        face_details = detect_face_details(image_data)

        if not face_details:
            return web.json_response({"emotion": "No face detected", "confidence": 0})

        if len(face_details) > 1:
            return web.json_response(
                {"emotion": "multiple_faces_detected", "confidence": 100}
            )

        emotions = face_details[0].get("Emotions", [])
        if not emotions:
            return web.json_response(
                {"emotion": "No emotion detected", "confidence": 0}
            )

        top_emotion = max(emotions, key=lambda x: x.get("Confidence", 0))

        return web.json_response(
            {
                "emotion": top_emotion.get("Type", "UNKNOWN"),
                "confidence": top_emotion.get("Confidence", 0),
                "allEmotions": [
                    {"type": e["Type"], "confidence": e["Confidence"]} for e in emotions
                ],
            }
        )

    except Exception as e:
        logger.error(f"Face analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)
