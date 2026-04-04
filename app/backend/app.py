import base64
import logging
import os
from pathlib import Path

import boto3
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import AzureDeveloperCliCredential, DefaultAzureCredential
from dotenv import load_dotenv

# RAG tools disabled - kept for future extensibility
# from ragtools import attach_rag_tools
from rtmt import RTMiddleTier

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voicerag")

async def analyze_face(request):
    try:
        data = await request.json()
        image_data = data.get('image', '')
        
        if not image_data:
            return web.json_response({'error': 'No image data provided'}, status=400)
        
        aws_region = os.environ.get('AWS_REGION', 'us-east-1')
        aws_access_key = os.environ.get('AWS_ACCESS_KEY_ID', '')
        aws_secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY', '')
        
        client_kwargs = {'region_name': aws_region}
        if aws_access_key and aws_secret_key and not aws_secret_key.startswith('secretref:'):
            client_kwargs['aws_access_key_id'] = aws_access_key
            client_kwargs['aws_secret_access_key'] = aws_secret_key
        
        rekognition = boto3.client('rekognition', **client_kwargs)
        
        image_bytes = base64.b64decode(image_data.split(',')[1])
        
        response = rekognition.detect_faces(
            Image={'Bytes': image_bytes},
            Attributes=['ALL']
        )
        
        if not response.get('FaceDetails'):
            return web.json_response({'emotion': 'No face detected', 'confidence': 0})
        
        emotions = response['FaceDetails'][0].get('Emotions', [])
        if not emotions:
            return web.json_response({'emotion': 'No emotion detected', 'confidence': 0})
        
        top_emotion = max(emotions, key=lambda x: x.get('Confidence', 0))
        
        return web.json_response({
            'emotion': top_emotion.get('Type', 'UNKNOWN'),
            'confidence': top_emotion.get('Confidence', 0),
            'allEmotions': [{'type': e['Type'], 'confidence': e['Confidence']} for e in emotions]
        })
    
    except Exception as e:
        logger.error(f"Face analysis error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def create_app():
    if not os.environ.get("RUNNING_IN_PRODUCTION"):
        logger.info("Running in development mode, loading from .env file")
        load_dotenv()

    llm_key = os.environ.get("AZURE_OPENAI_API_KEY")

    credential = None
    if not llm_key:
        if tenant_id := os.environ.get("AZURE_TENANT_ID"):
            logger.info("Using AzureDeveloperCliCredential with tenant_id %s", tenant_id)
            credential = AzureDeveloperCliCredential(tenant_id=tenant_id, process_timeout=60)
        else:
            logger.info("Using DefaultAzureCredential")
            credential = DefaultAzureCredential()
    llm_credential = AzureKeyCredential(llm_key) if llm_key else credential
    
    app = web.Application()

    app.router.add_post('/analyze', analyze_face)

    rtmt = RTMiddleTier(
        credentials=llm_credential,
        endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        deployment=os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT"],
        voice_choice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE_CHOICE") or "alloy"
        )
    
    # Enable sentiment analysis based on environment variable
    enable_sentiment = os.environ.get("ENABLE_SENTIMENT_ANALYSIS", "false").lower() == "true"
    rtmt.enable_sentiment_analysis = enable_sentiment
    if enable_sentiment:
        logger.info("Sentiment analysis is enabled")
    # RAG features disabled - simple conversational voice assistant
    rtmt.system_message = """
        You are a helpful voice assistant. Provide clear, concise answers to the user's questions.
        Keep responses short since the user is listening to audio.
    """.strip()

    # RAG tools disabled - kept for future extensibility
    # attach_rag_tools(rtmt,
    #     credentials=search_credential,
    #     search_endpoint=os.environ.get("AZURE_SEARCH_ENDPOINT"),
    #     search_index=os.environ.get("AZURE_SEARCH_INDEX"),
    #     semantic_configuration=os.environ.get("AZURE_SEARCH_SEMANTIC_CONFIGURATION") or None,
    #     identifier_field=os.environ.get("AZURE_SEARCH_IDENTIFIER_FIELD") or "chunk_id",
    #     content_field=os.environ.get("AZURE_SEARCH_CONTENT_FIELD") or "chunk",
    #     embedding_field=os.environ.get("AZURE_SEARCH_EMBEDDING_FIELD") or "text_vector",
    #     title_field=os.environ.get("AZURE_SEARCH_TITLE_FIELD") or "title",
    #     use_vector_query=(os.getenv("AZURE_SEARCH_USE_VECTOR_QUERY", "true") == "true")
    # )

    rtmt.attach_to_app(app, "/realtime")

    current_directory = Path(__file__).parent
    app.add_routes([web.get('/', lambda _: web.FileResponse(current_directory / 'static/index.html'))])
    app.router.add_static('/', path=current_directory / 'static', name='static')
    
    return app

if __name__ == "__main__":
    host = "localhost"
    port = 8765
    web.run_app(create_app(), host=host, port=port)
