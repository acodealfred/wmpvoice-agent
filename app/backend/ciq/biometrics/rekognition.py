"""AWS Rekognition face-emotion detection client."""
import base64
import os

import boto3


def detect_face_details(image_data: str) -> list:
    """Run Rekognition detect_faces on a data-URL image and return the FaceDetails list.

    Credentials come from the environment; explicit keys are used only when present and
    not a Container Apps secret-ref placeholder (otherwise fall back to the default chain).
    """
    aws_region = os.environ.get("AWS_REGION", "us-east-1")
    aws_access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
    aws_secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")

    client_kwargs = {"region_name": aws_region}
    if (
        aws_access_key
        and aws_secret_key
        and not aws_secret_key.startswith("secretref:")
    ):
        client_kwargs["aws_access_key_id"] = aws_access_key
        client_kwargs["aws_secret_access_key"] = aws_secret_key

    rekognition = boto3.client("rekognition", **client_kwargs)
    image_bytes = base64.b64decode(image_data.split(",")[1])
    response = rekognition.detect_faces(Image={"Bytes": image_bytes}, Attributes=["ALL"])
    return response.get("FaceDetails", [])
